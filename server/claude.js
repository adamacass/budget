const Anthropic = require('@anthropic-ai/sdk');

let client = null;

function getClient() {
  if (!client && process.env.ANTHROPIC_API_KEY) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
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
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
    return { advice: message.content[0].text };
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
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
    return { summary: message.content[0].text };
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
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
    return { advice: message.content[0].text };
  } catch (err) {
    console.error('Claude API error:', err.message);
    return { advice: `Claude API error: ${err.message}. Check your API key.` };
  }
}

async function extractTransactionsFromImage(base64Image, mediaType) {
  const anthropic = getClient();
  if (!anthropic) return { error: 'Claude API key not configured. Please add ANTHROPIC_API_KEY to your environment variables.' };

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Image }
          },
          {
            type: 'text',
            text: `Extract ALL transactions from this bank/credit card statement screenshot. For each transaction return:
- date: the transaction date in DD/MM/YY format
- description: the merchant/payee name exactly as shown
- amount: the dollar amount as a number (no $ sign, no negatives)

Return ONLY a JSON array, no other text. Example:
[{"date":"01/03/26","description":"Woolworths Metro Mosman","amount":30.00}]

Rules:
- Include every visible transaction, don't skip any
- Use the date as shown on the screenshot
- For amounts, just use the number (e.g. 30.00 not -$30.00)
- If a transaction says "Pending:", still include it
- Keep merchant names as-is from the screenshot
- If you can't read a value clearly, make your best guess`
          }
        ]
      }]
    });

    const text = message.content[0].text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return { error: 'Could not parse transactions from image', raw: text };

    const transactions = JSON.parse(jsonMatch[0]);
    return { transactions };
  } catch (err) {
    console.error('Claude vision API error:', err.message);
    return { error: `Claude API error: ${err.message}` };
  }
}

module.exports = { getPayDayAdvice, getNightlySummary, getAccountSweepAdvice, extractTransactionsFromImage };
