const Anthropic = require('@anthropic-ai/sdk');

let client = null;

function getClient() {
  if (!client && process.env.ANTHROPIC_API_KEY) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const MODEL = 'claude-haiku-5-5';

// Haiku 5.5 thinks by default, so a response can open with thinking blocks:
// read the answer from the text blocks rather than content[0]
function textOf(message) {
  if (message.stop_reason === 'refusal') throw new Error('Claude declined this request');
  return message.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

async function getPayDayAdvice({ user, netPay, retentionData, offsetBalance, goals, recentExpenses, upcomingExpenses, mortgageRate, mortgagePayment }) {
  const anthropic = getClient();
  if (!anthropic) return { advice: 'Claude API key not configured. Please add ANTHROPIC_API_KEY to your environment variables.' };

  const goalsText = goals.map(g => {
    const pct = g.target_amount > 0 ? ((g.current_amount / g.target_amount) * 100).toFixed(0) : 0;
    return `- ${g.name}: $${g.current_amount.toFixed(0)}/$${g.target_amount.toFixed(0)} (${pct}% complete, priority ${g.priority})`;
  }).join('\n');

  const expensesText = recentExpenses.slice(0, 20).map(e =>
    `- ${e.category}: $${e.amount} (${e.description || 'no desc'}) on ${e.expense_date}`
  ).join('\n');

  const upcomingText = upcomingExpenses.length > 0
    ? upcomingExpenses.map(e => `- ${e.description}: ~$${e.estimated_amount} expected ${e.expected_date}`).join('\n')
    : 'None flagged';

  const retentionBreakdown = retentionData?.by_category
    ? Object.entries(retentionData.by_category).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => `  ${cat}: ~$${amt}/period`).join('\n')
    : 'No data yet';

  const surplus = netPay - (retentionData?.calculated_retention || 0);

  const prompt = `You are a household financial advisor for a couple in Sydney, Australia. Be direct, specific, and actionable.

OFFSET-CENTRIC MODEL: All surplus cash goes to the mortgage offset account to reduce interest. Goals are virtual buckets within the offset — earmarks, not separate accounts.

CONTEXT:
- User: ${user.display_name} (${user.pay_cycle} pay cycle, $${user.gross_income.toLocaleString()} gross p.a.)
- Just received net pay: $${netPay.toFixed(2)}
- Mortgage: $${mortgagePayment.toLocaleString()}/month (auto-debited from offset by bank on 23rd)

RETENTION CALCULATION:
- System-calculated retention: $${(retentionData?.calculated_retention || 0).toFixed(2)} (what ${user.display_name} keeps for expenses)
- Based on last ${retentionData?.lookback_weeks || 8} weeks of spending + ${retentionData?.profile?.buffer_percent || 10}% buffer
- Spending breakdown per pay period:
${retentionBreakdown}
- Upcoming expenses factored in: $${(retentionData?.upcoming_extra || 0).toFixed(2)}

SURPLUS TO OFFSET: $${surplus.toFixed(2)} (net pay minus retention)

OFFSET ACCOUNT: $${(offsetBalance || 0).toLocaleString()} current balance
At ${(mortgageRate * 100).toFixed(2)}% mortgage rate, this saves ~$${Math.round((offsetBalance || 0) * mortgageRate / 12)}/month in interest

SAVINGS GOALS (virtual buckets within offset):
${goalsText || 'None set'}
Total earmarked for goals: $${goals.reduce((s, g) => s + g.current_amount, 0).toFixed(0)}
Unallocated offset: $${((offsetBalance || 0) - goals.reduce((s, g) => s + g.current_amount, 0)).toFixed(0)}

RECENT EXPENSES (last 2 weeks):
${expensesText || 'None recorded'}

UPCOMING EXPENSES:
${upcomingText}

INSTRUCTIONS:
1. Validate the retention amount — is it reasonable given the spending pattern?
2. Confirm the surplus going to offset is correct
3. Suggest which goals (if any) to allocate portions of the surplus to
4. Flag any spending concerns from recent expenses
5. Note if upcoming expenses mean retention should be higher

Provide your response as:
1. RETENTION CHECK — is the calculated retention sensible? Should it be adjusted?
2. OFFSET TRANSFER — confirm $${surplus.toFixed(2)} going to offset
3. GOAL SUGGESTIONS — which goals to contribute to from this surplus (if any)
4. WATCHOUTS — any concerns or tips`;

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });
    return { advice: textOf(message) };
  } catch (err) {
    console.error('Claude API error:', err.message);
    return { advice: `Claude API error: ${err.message}. Check your API key.` };
  }
}

async function getNightlySummary({ expenses, incomes, offsetBalance, goals, period, mortgageRate, mortgagePayment }) {
  const anthropic = getClient();
  if (!anthropic) return { summary: 'Claude API key not configured.' };

  const expensesByCategory = {};
  expenses.forEach(e => {
    if (!expensesByCategory[e.category]) expensesByCategory[e.category] = 0;
    expensesByCategory[e.category] += e.amount;
  });
  const catText = Object.entries(expensesByCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `- ${cat}: $${amt.toFixed(2)}`)
    .join('\n');

  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
  const totalIncome = incomes.reduce((s, i) => s + (i.net_amount || i.amount), 0);

  const goalsText = goals.map(g => {
    const pct = g.target_amount > 0 ? ((g.current_amount / g.target_amount) * 100).toFixed(1) : 0;
    return `- ${g.name}: ${pct}% complete ($${g.current_amount.toFixed(0)}/$${g.target_amount.toFixed(0)})`;
  }).join('\n');

  const totalGoalAllocated = goals.reduce((s, g) => s + g.current_amount, 0);
  const unallocatedOffset = (offsetBalance || 0) - totalGoalAllocated;
  const effectiveMortgageRate = mortgageRate || 0.0624;
  const monthlyInterestSaved = ((offsetBalance || 0) * effectiveMortgageRate) / 12;

  const prompt = `You are a sharp, honest household financial advisor for a Sydney couple. Give a nightly review focused on offset account growth.

OFFSET-CENTRIC MODEL: All surplus goes to offset to reduce mortgage interest. Goals are virtual buckets within offset.

PERIOD: ${period}
TOTAL INCOME (net): $${totalIncome.toFixed(2)}
TOTAL EXPENSES: $${totalExpenses.toFixed(2)}
NET: $${(totalIncome - totalExpenses).toFixed(2)}

EXPENSES BY CATEGORY:
${catText || 'No expenses recorded'}

OFFSET ACCOUNT: $${(offsetBalance || 0).toLocaleString()}
- Interest saved: ~$${Math.round(monthlyInterestSaved)}/month ($${Math.round(monthlyInterestSaved * 12)}/year)
- Mortgage: $${(mortgagePayment || 4656.64).toLocaleString()}/month (auto-debited from offset)
- Goals allocated within offset: $${totalGoalAllocated.toFixed(0)}
- Unallocated offset: $${unallocatedOffset.toFixed(0)}

SAVINGS GOALS (virtual offset buckets):
${goalsText || 'None set'}

SYDNEY BENCHMARKS (monthly):
- Groceries: $800-1200 | Dining out: $300-500 | Transport: $200-400
- Utilities: $300-450 | Health/fitness: $150-300 | Clothing: $100-250

INSTRUCTIONS:
Be constructive but honest. Focus on how spending impacts offset growth.
1. VERDICT — one-line summary (are we growing the offset?)
2. WINS — what's going well
3. CONCERNS — where spending could be tighter
4. OFFSET IMPACT — how current trajectory affects offset growth and interest savings
5. TIP — one specific actionable suggestion`;

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });
    return { summary: textOf(message) };
  } catch (err) {
    console.error('Claude API error:', err.message);
    return { summary: `Claude API error: ${err.message}` };
  }
}

async function getAccountSweepAdvice({ user, transactionBalance, offsetBalance, goals, recentExpenses, upcomingExpenses, budgets, budgetScale, mortgageRate, mortgagePayment }) {
  const anthropic = getClient();
  if (!anthropic) return { advice: 'Claude API key not configured. Please add ANTHROPIC_API_KEY to your environment variables.' };

  const goalsText = goals.map(g => `- ${g.name}: $${g.current_amount.toFixed(0)}/$${g.target_amount.toFixed(0)} (priority ${g.priority})`).join('\n');
  const expensesText = recentExpenses.slice(0, 20).map(e => `- ${e.category}: $${e.amount} (${e.description || 'no desc'}) on ${e.expense_date}`).join('\n');
  const upcomingText = upcomingExpenses.length > 0
    ? upcomingExpenses.map(e => `- ${e.description}: ~$${e.estimated_amount} expected ${e.expected_date}`).join('\n')
    : 'None flagged';

  const totalBudget = budgets.reduce((s, b) => s + b.monthly_amount * budgetScale, 0);
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthProgress = dayOfMonth / daysInMonth;

  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const thisMonthExpenses = recentExpenses.filter(e => e.expense_date >= monthStart);
  const totalSpentThisMonth = thisMonthExpenses.reduce((s, e) => s + e.amount, 0);
  const remainingBudget = totalBudget - totalSpentThisMonth;

  const prompt = `You are a household financial advisor for a couple in Sydney. Be direct and specific.

OFFSET-CENTRIC MODEL: All excess cash goes to offset to reduce mortgage interest. No savings/investment account splits.

CONTEXT:
- User: ${user.display_name}
- Transaction account balance: $${transactionBalance.toFixed(2)}
- This is NOT payday — reviewing what's in the transaction account

OFFSET ACCOUNT: $${(offsetBalance || 0).toLocaleString()}
At ${((mortgageRate || 0.0624) * 100).toFixed(2)}% rate, every $1,000 in offset saves ~$${Math.round((mortgageRate || 0.0624) * 1000)}/year in interest

MONTHLY BUDGET STATUS (${Math.round(monthProgress * 100)}% through month):
- Budget: $${Math.round(totalBudget)}/month
- Spent so far: $${totalSpentThisMonth.toFixed(2)}
- Remaining: ~$${Math.round(remainingBudget)}

SAVINGS GOALS (offset buckets): ${goalsText || 'None'}
UPCOMING EXPENSES: ${upcomingText}
RECENT EXPENSES: ${expensesText || 'None'}

INSTRUCTIONS:
1. How much of the $${transactionBalance.toFixed(2)} should stay for remaining expenses?
2. What's the excess that should go to offset?
3. Any reason NOT to send the excess to offset right now?

Provide:
1. KEEP — how much to leave in transaction account and why
2. TRANSFER — how much to send to offset
3. RATIONALE — brief explanation
4. WATCHOUTS — any concerns`;

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });
    return { advice: textOf(message) };
  } catch (err) {
    console.error('Claude API error:', err.message);
    return { advice: `Claude API error: ${err.message}. Check your API key.` };
  }
}

async function extractTransactionsFromImage(base64Image, mediaType) {
  const anthropic = getClient();
  if (!anthropic) return { error: 'Claude API key not configured. Please add ANTHROPIC_API_KEY to your environment variables.' };

  const today = new Date().toLocaleDateString('en-AU', {
    timeZone: process.env.TZ || 'Australia/Sydney', day: '2-digit', month: '2-digit', year: '2-digit',
  });

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              readable: { type: 'boolean' },
              screen_type: { type: 'string', enum: ['banking', 'bill'] },
              bill: {
                type: 'object',
                properties: {
                  biller: { type: 'string' },
                  amount_due: { type: ['number', 'null'] },
                  due_date: { type: ['string', 'null'] },
                  reference: { type: ['string', 'null'] },
                  category: { type: 'string', enum: ['Utilities', 'Insurance', 'Subscriptions', 'Health', 'Education', 'Home', 'Transport', 'Other'] },
                  period_start: { type: ['string', 'null'] },
                  period_end: { type: ['string', 'null'] },
                },
                required: ['biller', 'amount_due', 'due_date', 'reference', 'category', 'period_start', 'period_end'],
                additionalProperties: false,
              },
              account_kind: { type: 'string', enum: ['offset', 'everyday', 'credit_card', 'other'] },
              account_name: { type: 'string' },
              balance: { type: ['number', 'null'] },
              transactions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    date: { type: 'string' },
                    description: { type: 'string' },
                    amount: { type: 'number' },
                    direction: { type: 'string', enum: ['out', 'in'] },
                  },
                  required: ['date', 'description', 'amount', 'direction'],
                  additionalProperties: false,
                },
              },
            },
            required: ['readable', 'screen_type', 'bill', 'account_kind', 'account_name', 'balance', 'transactions'],
            additionalProperties: false,
          },
        },
      },
      messages: [{
        role: 'user',
        content: [
          mediaType === 'application/pdf'
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Image } }
            : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
          {
            type: 'text',
            text: `This is either a screenshot from an Australian banking app (often NAB) or card statement, or a bill (energy, water, phone, internet, insurance, rates, strata, rego, a subscription renewal...), photographed or as a PDF. Read it.

- readable: false if it's neither, or too blurry or cropped to read.
- screen_type: "bill" for a bill or invoice asking to be paid; "banking" for a banking app or statement screen.
- bill (for a banking screen, fill it with biller "" and nulls, category "Other"):
  - biller: the company, short and recognisable (e.g. "AGL Energy", "Sydney Water").
  - amount_due: the total now due, as a number; null if not shown.
  - due_date: YYYY-MM-DD; null if not shown. Today is ${today} (DD/MM/YY).
  - reference: the BPAY biller code and reference, or account/customer number, as shown; null if none.
  - category: the closest budget category.
  - period_start / period_end: the billing period as YYYY-MM-DD, if shown; otherwise null.
- For a bill, use account_kind "other", account_name "", balance null and an empty transactions list.
- account_kind: "offset" if the screen is a home loan offset account (the account name says Offset, or it's linked to a home loan); "credit_card" for a card; "everyday" for a transaction or everyday account; otherwise "other".
- account_name: the account name as shown, or "" if none is visible.
- balance: the account's current balance if it is shown (the main "balance" or "available" figure for this account), as a number; null if not shown.
- transactions: every visible transaction, none skipped, including pending ones:
  - date: DD/MM/YY. Today is ${today}. If the screen shows no year, use the year that puts the date on or before today, which is usually the current year. Under a heading like "Today" or "Yesterday", work it out from today.
  - description: the merchant or payee exactly as shown.
  - amount: a positive number, no $ sign or minus.
  - direction: "out" for money leaving the account (purchases, payments, debits, shown with a minus), "in" for money arriving (deposits, salary, transfers in, refunds, shown with a plus or as a credit).
- If a value is hard to read, give your best guess.`
          }
        ]
      }]
    });

    const parsed = JSON.parse(textOf(message));
    if (!parsed.readable) return { error: "That doesn't look like a readable banking screenshot or bill." };
    return {
      screen_type: parsed.screen_type,
      bill: parsed.screen_type === 'bill' ? parsed.bill : null,
      transactions: parsed.screen_type === 'bill' ? [] : (parsed.transactions || []),
      account_kind: parsed.account_kind,
      account_name: parsed.account_name,
      balance: typeof parsed.balance === 'number' ? parsed.balance : null,
    };
  } catch (err) {
    console.error('Claude vision API error:', err.message);
    return { error: `Claude API error: ${err.message}` };
  }
}

// Picks a category for each description from a fixed list, guided by how the
// household has categorised its own past spending. Returns an array aligned
// with `descriptions` ({ category, confidence }), or null without an API key.
async function categorizeTransactions(descriptions, { categories, examples }) {
  const anthropic = getClient();
  if (!anthropic || !descriptions.length) return null;

  const exampleText = examples.map(e => `${e.description} => ${e.category}`).join('\n');
  const list = descriptions.map((d, i) => `${i}. ${d}`).join('\n');

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  category: { type: 'string', enum: categories },
                  confidence: { type: 'string', enum: ['high', 'low'] },
                },
                required: ['index', 'category', 'confidence'],
                additionalProperties: false,
              },
            },
          },
          required: ['items'],
          additionalProperties: false,
        },
      },
    },
    messages: [{
      role: 'user',
      content: `Categorise each bank transaction for a Sydney household's budget. Choose exactly one category per transaction from: ${categories.join(', ')}.

How this household has categorised merchants before (follow these where a merchant matches):
${exampleText || '(no history yet)'}

Guidance:
- Bank descriptions are noisy: card prefixes like "Sq *", "Zlr*", "Sp ", store numbers and suburbs can be ignored. "Transportfornsw Tap" is public transport.
- Transfer is money moving between the household's own accounts (to the offset, savings or a partner); it is not spending. Mortgage is a home loan repayment.
- Use Other only when nothing else fits.
- confidence is "high" when the merchant is clear or matches the history, "low" when you are guessing (an unfamiliar company name, say).

Transactions:
${list}`,
    }],
  });

  const text = textOf(message);
  const parsed = JSON.parse(text);
  const out = new Array(descriptions.length).fill(null);
  for (const item of parsed.items || []) {
    if (Number.isInteger(item.index) && item.index >= 0 && item.index < out.length) out[item.index] = item;
  }
  return out;
}

// Turns a reply like "3 is groceries, remove 5, 7 was $12.50" into edits on a
// pending screenshot batch. `lines` is the numbered list the user is looking at.
async function parseBatchFixes(reply, { lines, categories }) {
  const anthropic = getClient();
  if (!anthropic) return null;

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            is_fix: { type: 'boolean' },
            edits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  number: { type: 'integer' },
                  action: { type: 'string', enum: ['remove', 'include', 'set_category', 'set_amount', 'set_description', 'set_date', 'set_balance'] },
                  value: { type: 'string' },
                },
                required: ['number', 'action', 'value'],
                additionalProperties: false,
              },
            },
          },
          required: ['is_fix', 'edits'],
          additionalProperties: false,
        },
      },
    },
    messages: [{
      role: 'user',
      content: `A user is reviewing transactions read from their banking screenshots before saving them. Here is the numbered list they can see:

${lines}

Categories available: ${categories.join(', ')}

Their reply:
"""${reply}"""

If the reply asks to change the list, set is_fix true and give one edit per change:
- remove: drop that number. include: put back a number marked as already recorded, possible duplicate or removed.
- set_category: value is exactly one of the categories above (pick the closest).
- set_amount: value is a plain number. set_description: value is the new text. set_date: value is YYYY-MM-DD.
- set_balance: the offset balance shown in the list is wrong; number is 0, value is a plain number.
- "all", ranges ("3-5") and lists ("2, 4 and 6") expand to one edit per number.
If the reply is a question or anything else that doesn't change the list, set is_fix false with no edits.`,
    }],
  });

  return JSON.parse(textOf(message));
}

module.exports = { getPayDayAdvice, getNightlySummary, getAccountSweepAdvice, extractTransactionsFromImage, categorizeTransactions, parseBatchFixes };
