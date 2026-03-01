const Anthropic = require('@anthropic-ai/sdk');

let client = null;

function getClient() {
  if (!client && process.env.ANTHROPIC_API_KEY) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

async function getPayDayAdvice({ user, netPay, accountBalances, goals, levers, recentExpenses, upcomingExpenses }) {
  const anthropic = getClient();
  if (!anthropic) return { advice: 'Claude API key not configured. Please add ANTHROPIC_API_KEY to your environment variables.' };

  const goalsText = goals.map(g => `- ${g.name}: $${g.current_amount.toFixed(0)}/$${g.target_amount.toFixed(0)} (priority ${g.priority}${g.target_date ? ', target: ' + g.target_date : ''})`).join('\n');
  const leversText = levers.map(l => `- ${l.name}: ${l.lever_type === 'percentage' ? l.value + '%' : '$' + l.value}`).join('\n');
  const expensesText = recentExpenses.slice(0, 20).map(e => `- ${e.category}: $${e.amount} (${e.description || 'no desc'}) on ${e.expense_date}`).join('\n');
  const upcomingText = upcomingExpenses.length > 0
    ? upcomingExpenses.map(e => `- ${e.description}: ~$${e.estimated_amount} expected ${e.expected_date}${e.notes ? ' (' + e.notes + ')' : ''}`).join('\n')
    : 'None flagged';

  const prompt = `You are a household financial advisor for a couple in Sydney, Australia. Be direct, specific, and actionable.

CONTEXT:
- User: ${user.display_name} (${user.pay_cycle} pay cycle, $${user.gross_income.toLocaleString()} gross p.a.)
- Just received net pay: $${netPay.toFixed(2)}

ACCOUNT BALANCES:
- Personal savings: $${(accountBalances.savings || 0).toFixed(2)}
- Offset account: $${(accountBalances.offset || 0).toFixed(2)} (on mortgage)
- Credit card owing: $${(accountBalances.credit_card || 0).toFixed(2)}
- Investment account: $${(accountBalances.investment || 0).toFixed(2)}

MONTHLY MORTGAGE: $4,587.83

SAVINGS GOALS:
${goalsText || 'None set'}

ALLOCATION LEVERS (user-set preferences):
${leversText || 'None set'}

RECENT EXPENSES (last 2 weeks):
${expensesText || 'None recorded'}

UPCOMING BULGE EXPENSES:
${upcomingText}

INSTRUCTIONS:
1. Calculate exactly how much from this $${netPay.toFixed(2)} pay should go to each account
2. Consider the credit card needs to be paid (reflects last month spending)
3. Factor in the upcoming bulge expenses when allocating
4. Prioritise according to the levers set above
5. The offset account saves mortgage interest — every dollar there counts
6. Be specific: "Transfer $X to [account]" for each allocation
7. Flag any concerns about spending patterns
8. If there are upcoming large expenses, reserve funds accordingly

Provide your response as:
1. ALLOCATION PLAN — exact dollar amounts for each account
2. RATIONALE — brief explanation of priorities
3. WATCHOUTS — any concerns or suggestions`;

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

async function getNightlySummary({ expenses, incomes, accountBalances, goals, levers, period }) {
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

  const prompt = `You are a sharp, honest household financial advisor for a Sydney couple. Give a nightly spending review.

PERIOD: ${period}
TOTAL INCOME (net): $${totalIncome.toFixed(2)}
TOTAL EXPENSES: $${totalExpenses.toFixed(2)}
NET: $${(totalIncome - totalExpenses).toFixed(2)}

EXPENSES BY CATEGORY:
${catText || 'No expenses recorded'}

ACCOUNT BALANCES:
- Offset: $${(accountBalances.offset || 0).toFixed(2)}
- Savings: $${(accountBalances.savings || 0).toFixed(2)}
- Credit card: $${(accountBalances.credit_card || 0).toFixed(2)}
- Investment: $${(accountBalances.investment || 0).toFixed(2)}

SAVINGS GOALS:
${goalsText || 'None set'}

MONTHLY MORTGAGE: $4,587.83

SYDNEY MID-HIGH BENCHMARKS (monthly):
- Groceries: $800-1200
- Dining out: $300-500
- Transport: $200-400
- Utilities: $300-450
- Insurance: $200-350
- Entertainment: $150-300
- Health/fitness: $150-300
- Clothing: $100-250
- Personal care: $80-150

INSTRUCTIONS:
Be constructive but honest. Give specific praise where spending is disciplined and specific critique where it's not.
1. VERDICT — one-line summary (are we on track?)
2. WINS — what's going well
3. CONCERNS — where spending is above benchmarks
4. SAVINGS IMPACT — how current trajectory affects goals
5. TIP OF THE DAY — one specific actionable suggestion`;

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

async function getAccountSweepAdvice({ user, transactionBalance, accountBalances, goals, levers, recentExpenses, upcomingExpenses, budgets, budgetScale }) {
  const anthropic = getClient();
  if (!anthropic) return { advice: 'Claude API key not configured. Please add ANTHROPIC_API_KEY to your environment variables.' };

  const goalsText = goals.map(g => `- ${g.name}: $${g.current_amount.toFixed(0)}/$${g.target_amount.toFixed(0)} (priority ${g.priority}${g.target_date ? ', target: ' + g.target_date : ''})`).join('\n');
  const leversText = levers.map(l => `- ${l.name}: ${l.lever_type === 'percentage' ? l.value + '%' : '$' + l.value}`).join('\n');
  const expensesText = recentExpenses.slice(0, 20).map(e => `- ${e.category}: $${e.amount} (${e.description || 'no desc'}) on ${e.expense_date}`).join('\n');
  const upcomingText = upcomingExpenses.length > 0
    ? upcomingExpenses.map(e => `- ${e.description}: ~$${e.estimated_amount} expected ${e.expected_date}${e.notes ? ' (' + e.notes + ')' : ''}`).join('\n')
    : 'None flagged';

  const budgetText = budgets.map(b => `- ${b.category}: $${Math.round(b.monthly_amount * budgetScale)}/mo`).join('\n');
  const totalBudget = budgets.reduce((s, b) => s + b.monthly_amount * budgetScale, 0);

  // Calculate how much of monthly budget cycle has been spent
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthProgress = dayOfMonth / daysInMonth;

  // Sum recent expenses by category for this calendar month
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const thisMonthExpenses = recentExpenses.filter(e => e.expense_date >= monthStart);
  const spentByCategory = {};
  thisMonthExpenses.forEach(e => {
    if (!spentByCategory[e.category]) spentByCategory[e.category] = 0;
    spentByCategory[e.category] += e.amount;
  });
  const spentText = Object.entries(spentByCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `- ${cat}: $${amt.toFixed(2)} spent so far`)
    .join('\n');
  const totalSpentThisMonth = Object.values(spentByCategory).reduce((s, v) => s + v, 0);

  const prompt = `You are a household financial advisor for a couple in Sydney, Australia. Be direct, specific, and actionable.

CONTEXT:
- User: ${user.display_name} (${user.pay_cycle} pay cycle, $${user.gross_income.toLocaleString()} gross p.a.)
- Current amount sitting in transaction account: $${transactionBalance.toFixed(2)}
- This is NOT a pay day — we're reviewing what's in the transaction account and deciding what to do with it.

ACCOUNT BALANCES:
- Transaction account: $${transactionBalance.toFixed(2)} (this is what we're deciding about)
- Personal savings: $${(accountBalances.savings || 0).toFixed(2)}
- Offset account: $${(accountBalances.offset || 0).toFixed(2)} (on mortgage)
- Credit card owing: $${(accountBalances.credit_card || 0).toFixed(2)}
- Investment account: $${(accountBalances.investment || 0).toFixed(2)}

MONTHLY MORTGAGE: $4,587.83

HOUSEHOLD BUDGET (monthly, scaled at ${Math.round(budgetScale * 100)}%):
${budgetText}
Total monthly budget: $${Math.round(totalBudget)}

THIS MONTH'S SPENDING SO FAR (${Math.round(monthProgress * 100)}% through the month):
${spentText || 'Nothing recorded yet'}
Total spent this month: $${totalSpentThisMonth.toFixed(2)}
Remaining budget this month: $${Math.round(totalBudget - totalSpentThisMonth)}

SAVINGS GOALS:
${goalsText || 'None set'}

ALLOCATION LEVERS (user-set preferences):
${leversText || 'None set'}

RECENT EXPENSES (last 2 weeks):
${expensesText || 'None recorded'}

UPCOMING BULGE EXPENSES:
${upcomingText}

INSTRUCTIONS:
1. Look at the $${transactionBalance.toFixed(2)} in the transaction account
2. Work out how much needs to stay to cover remaining budgeted expenses for this month (~$${Math.round(totalBudget - totalSpentThisMonth)} remaining in budget, but only ${Math.round((1 - monthProgress) * 100)}% of the month left)
3. If there's credit card debt, recommend paying that first
4. Whatever is surplus above what's needed for expenses, recommend how to split it across offset/savings/investment per the levers
5. Factor in any upcoming bulge expenses
6. Be specific: "Keep $X in transaction for expenses, transfer $X to [account]"
7. Flag if the transaction balance is low relative to remaining monthly expenses

Provide your response as:
1. RECOMMENDATION — what to do with the $${transactionBalance.toFixed(2)}
2. KEEP IN TRANSACTION — how much to leave for upcoming expenses and why
3. SWEEP PLAN — exact dollar amounts to transfer to each account
4. RATIONALE — brief explanation
5. WATCHOUTS — any concerns`;

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
    // Extract JSON from response (handle markdown code blocks)
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
