// Builds the offset-centric summaries the bot sends out.
//
// Everything here is framed around the offset account: what went in, what came
// out, and what that does to the mortgage. Spending is reported because it
// determines how much reaches the offset, not as an end in itself.

const DAY = 86400000;

function fmt(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('en-AU');
}
function fmt2(n) {
  return '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function signed(n) {
  const v = Math.round(Number(n) || 0);
  return (v >= 0 ? '+' : '') + fmt(Math.abs(v)).replace('$', v >= 0 ? '$' : '-$').replace('-$-', '-$');
}
function pct(n) {
  return (Number(n) || 0).toFixed(2).replace(/\.?0+$/, '') + '%';
}
// A local (TZ, normally Australia/Sydney) date, not UTC: at 8am in Sydney it is
// still the previous day in UTC, which would shift "yesterday" back a day
function daysAgo(n) {
  return new Date(Date.now() - n * DAY).toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'Australia/Sydney' });
}

// Current offset position plus what it's saving in interest
async function offsetSnapshot(db, mortgageConfig) {
  const balRow = (await db.query(
    "SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1"
  )).rows[0];
  const balance = balRow ? parseFloat(balRow.balance) : 0;

  const goals = (await db.query(
    'SELECT id, name, current_amount, target_amount FROM savings_goals WHERE active = 1 ORDER BY priority'
  )).rows.map(g => ({ ...g, current_amount: parseFloat(g.current_amount) || 0 }));
  const allocated = goals.reduce((s, g) => s + g.current_amount, 0);

  // Every dollar in the offset is a dollar of mortgage not accruing interest
  const monthlyInterestSaved = balance * (mortgageConfig.rate / 12);

  return {
    balance,
    allocated,
    unallocated: balance - allocated,
    goals,
    monthly_interest_saved: monthlyInterestSaved,
    annual_interest_saved: monthlyInterestSaved * 12,
  };
}

// Movement over a window: pay in, mortgage out, withdrawals out
async function offsetFlow(db, sinceDate) {
  const payIn = parseFloat((await db.query(
    'SELECT SUM(COALESCE(offset_transfer, 0)) as t FROM income_entries WHERE pay_date >= $1', [sinceDate]
  )).rows[0]?.t) || 0;

  const withdrawn = parseFloat((await db.query(
    'SELECT SUM(amount) as t FROM offset_withdrawals WHERE withdrawal_date >= $1', [sinceDate]
  )).rows[0]?.t) || 0;

  const mortgage = Math.abs(parseFloat((await db.query(
    "SELECT SUM(amount) as t FROM fund_allocations WHERE allocated_date >= $1 AND notes LIKE 'Mortgage%'", [sinceDate]
  )).rows[0]?.t) || 0);

  return { in: payIn, withdrawn, mortgage, net: payIn - withdrawn - mortgage };
}

async function spendingSince(db, sinceDate, nonSpending) {
  const total = parseFloat((await db.query(
    'SELECT SUM(amount) as t FROM expenses WHERE expense_date >= $1 AND NOT (category = ANY($2))',
    [sinceDate, nonSpending]
  )).rows[0]?.t) || 0;

  const byCategory = (await db.query(
    `SELECT category, SUM(amount) as total, COUNT(*) as n FROM expenses
     WHERE expense_date >= $1 AND NOT (category = ANY($2))
     GROUP BY category ORDER BY SUM(amount) DESC`,
    [sinceDate, nonSpending]
  )).rows.map(r => ({ category: r.category, total: parseFloat(r.total), count: parseInt(r.n) }));

  return { total, byCategory };
}

// How long until the mortgage is gone, given current offset and monthly saving
function payoffProjection(mc, offsetBalance, monthlySaving) {
  const monthsElapsed = (() => {
    const start = new Date(mc.startDate + 'T00:00:00');
    const now = new Date();
    return (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  })();

  // Reconstruct today's balance by amortising from the start
  let balance = mc.principal;
  for (let m = 0; m < monthsElapsed && balance > 0; m++) {
    const interest = balance * mc.monthlyRate;
    balance -= Math.min(mc.monthlyPayment - interest, balance);
  }

  // Project forward with the offset growing by whatever is left after the repayment
  let bal = balance;
  let off = offsetBalance;
  let months = 0;
  const limit = mc.termMonths - monthsElapsed;
  while (bal > 0 && months < limit + 1) {
    const effective = Math.max(0, bal - off);
    const interest = effective * mc.monthlyRate;
    bal = Math.max(0, bal - Math.min(mc.monthlyPayment - interest, bal));
    off = Math.max(0, off + monthlySaving - mc.monthlyPayment);
    months++;
  }

  const payoffDate = new Date();
  payoffDate.setMonth(payoffDate.getMonth() + months);
  const originalPayoff = new Date(mc.startDate + 'T00:00:00');
  originalPayoff.setMonth(originalPayoff.getMonth() + mc.termMonths);
  const savedMonths = Math.max(0, limit - months);

  return {
    current_balance: balance,
    months_remaining: months,
    payoff_date: payoffDate,
    original_payoff_date: originalPayoff,
    months_saved: savedMonths,
    years_saved: Math.floor(savedMonths / 12),
    rem_months_saved: savedMonths % 12,
  };
}

// Measured monthly saving — what actually reached the offset, not an estimate
async function measuredMonthlySaving(db) {
  const since = daysAgo(182);
  const payIn = parseFloat((await db.query(
    'SELECT SUM(COALESCE(offset_transfer, 0)) as t FROM income_entries WHERE pay_date >= $1', [since]
  )).rows[0]?.t) || 0;
  const withdrawn = parseFloat((await db.query(
    'SELECT SUM(amount) as t FROM offset_withdrawals WHERE withdrawal_date >= $1', [since]
  )).rows[0]?.t) || 0;
  const first = (await db.query(
    'SELECT MIN(pay_date) as d FROM income_entries WHERE pay_date >= $1 AND COALESCE(offset_transfer, 0) > 0', [since]
  )).rows[0]?.d;

  if (!first) return { monthly: 0, months: 0, have_data: false };
  const firstMs = new Date(String(first).slice(0, 10) + 'T00:00:00Z').getTime();
  const months = Math.max(1, (Date.now() - firstMs) / (DAY * 30.44));
  return { monthly: (payIn - withdrawn) / months, months, have_data: true };
}

// ---------------------------------------------------------------------------
// Public builders — each returns a plain string for Telegram (HTML parse mode)
// ---------------------------------------------------------------------------

// Every number the daily update shows, for both the text and the image card
async function buildDigestData(db, { mortgageConfig, nonSpending }) {
  const snap = await offsetSnapshot(db, mortgageConfig);
  const yesterday = daysAgo(1);
  const weekAgo = daysAgo(7);
  const monthAgo = daysAgo(30);

  const daySpend = await spendingSince(db, yesterday, nonSpending);
  const weekSpend = await spendingSince(db, weekAgo, nonSpending);
  const monthSpend = await spendingSince(db, monthAgo, nonSpending);
  const flow = await offsetFlow(db, monthAgo);
  const saving = await measuredMonthlySaving(db);
  const proj = payoffProjection(mortgageConfig, snap.balance, saving.monthly);

  // Compare this week against the previous one to give the number direction
  const prevWeek = parseFloat((await db.query(
    'SELECT SUM(amount) as t FROM expenses WHERE expense_date >= $1 AND expense_date < $2 AND NOT (category = ANY($3))',
    [daysAgo(14), weekAgo, nonSpending]
  )).rows[0]?.t) || 0;
  const weekDelta = prevWeek > 0 ? ((weekSpend.total - prevWeek) / prevWeek) * 100 : 0;

  // Spending per day for the last 7 full days (up to yesterday), oldest first,
  // zero-filled; the update goes out in the morning, when today is still empty
  const byDay = new Map((await db.query(
    `SELECT expense_date AS d, SUM(amount) AS t FROM expenses
     WHERE expense_date >= $1 AND expense_date < $2 AND NOT (category = ANY($3)) GROUP BY expense_date`,
    [daysAgo(7), daysAgo(0), nonSpending]
  )).rows.map(r => [r.d, parseFloat(r.t) || 0]));
  const daily = [];
  for (let i = 7; i >= 1; i--) {
    const d = daysAgo(i);
    daily.push({ date: d, total: byDay.get(d) || 0 });
  }

  const byPerson = await spendingByPerson(db, daysAgo(7), daysAgo(0), nonSpending);

  return { snap, daySpend, weekSpend, monthSpend, flow, saving, proj, prevWeek, weekDelta, daily, byPerson };
}

// Each person's spending by category between two dates (from inclusive, to exclusive)
async function spendingByPerson(db, from, to, nonSpending) {
  const rows = (await db.query(
    `SELECT u.id, u.display_name, e.category, SUM(e.amount) AS total, COUNT(*) AS n
     FROM users u LEFT JOIN expenses e ON e.user_id = u.id
       AND e.expense_date >= $1 AND e.expense_date < $2 AND NOT (e.category = ANY($3))
     GROUP BY u.id, u.display_name, e.category
     ORDER BY u.id, SUM(e.amount) DESC NULLS LAST`,
    [from, to, nonSpending]
  )).rows;
  const people = new Map();
  for (const r of rows) {
    if (!people.has(r.id)) people.set(r.id, { name: r.display_name, total: 0, categories: [] });
    if (!r.category) continue;
    const p = people.get(r.id);
    const total = parseFloat(r.total) || 0;
    p.total += total;
    p.categories.push({ category: r.category, total, count: parseInt(r.n) });
  }
  return { from, to, people: [...people.values()] };
}

function shortDay(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
}

// "This week by person": every category each person spent on, biggest first
function personWeekLines(byPerson) {
  const last = daysAgoFrom(byPerson.to, 1);
  const lines = [`<b>This week by person</b>  <i>${shortDay(byPerson.from)} – ${shortDay(last)}</i>`];
  for (const p of byPerson.people) {
    lines.push('');
    lines.push(`<b>${p.name}</b>  ${fmt(p.total)}`);
    if (!p.categories.length) { lines.push('   nothing logged'); continue; }
    for (const c of p.categories) lines.push(`   ${c.category}  ${fmt(c.total)}`);
  }
  return lines;
}

function daysAgoFrom(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split('T')[0];
}

// The caption under the daily card. The card carries the offset and payoff
// figures, so the text adds what the picture doesn't: who spent what.
function buildDigestCaption(data) {
  const { snap, flow } = data;
  const lines = [
    `💰 <b>${fmt(snap.balance)}</b> in the offset  ·  ${flow.net >= 0 ? '▲ up' : '▼ down'} ${fmt(Math.abs(flow.net))} over 30 days`,
    '',
    ...personWeekLines(data.byPerson),
  ];
  return lines.join('\n');
}

async function buildWeekByPerson(db, { nonSpending }) {
  const byPerson = await spendingByPerson(db, daysAgo(7), daysAgo(0), nonSpending);
  const today = await spendingByPerson(db, daysAgo(0), daysAgo(-1), nonSpending);
  const lines = personWeekLines(byPerson);
  const todayTotal = today.people.reduce((s, p) => s + p.total, 0);
  if (todayTotal > 0) {
    lines.push('');
    lines.push(`<i>Plus ${fmt(todayTotal)} so far today: ${today.people.filter(p => p.total > 0).map(p => `${p.name} ${fmt(p.total)}`).join(', ')}</i>`);
  }
  return lines.join('\n');
}

// The full update as text: sent on its own when the card can't be drawn
async function buildDailyDigest(db, { mortgageConfig, nonSpending, data }) {
  const d = data || await buildDigestData(db, { mortgageConfig, nonSpending });
  const { snap, daySpend, weekSpend, monthSpend, flow, saving, proj, prevWeek, weekDelta } = d;

  const lines = [];
  lines.push('<b>Offset update</b>');
  lines.push('');
  lines.push(`💰 <b>${fmt(snap.balance)}</b> in the offset`);
  lines.push(`   saving ${fmt(snap.monthly_interest_saved)}/mo in interest`);
  lines.push('');

  lines.push('<b>Last 30 days through the offset</b>');
  lines.push(`   in from pay      ${fmt(flow.in)}`);
  lines.push(`   mortgage out     −${fmt(flow.mortgage)}`);
  if (flow.withdrawn > 0) lines.push(`   withdrawn        −${fmt(flow.withdrawn)}`);
  lines.push(`   <b>net            ${flow.net >= 0 ? '+' : '−'}${fmt(Math.abs(flow.net))}</b>`);
  lines.push('');

  lines.push('<b>Spending</b>');
  lines.push(`   yesterday  ${fmt(daySpend.total)}`);
  lines.push(`   last 7d    ${fmt(weekSpend.total)}${prevWeek > 0 ? `  (${weekDelta >= 0 ? '↑' : '↓'}${Math.abs(weekDelta).toFixed(0)}% vs prior week)` : ''}`);
  lines.push(`   last 30d   ${fmt(monthSpend.total)}`);
  if (weekSpend.byCategory.length) {
    const top = weekSpend.byCategory.slice(0, 3).map(c => `${c.category} ${fmt(c.total)}`).join(', ');
    lines.push(`   top this week: ${top}`);
  }
  lines.push('');

  lines.push('<b>Trajectory</b>');
  if (saving.have_data) {
    lines.push(`   adding ${fmt(saving.monthly)}/mo to the offset`);
  } else {
    lines.push(`   no pay data yet — add a pay day to project`);
  }
  lines.push(`   owing ${fmt(proj.current_balance)}`);
  lines.push(`   mortgage-free ${proj.payoff_date.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })}`);
  if (proj.months_saved > 0) {
    const t = proj.years_saved > 0
      ? `${proj.years_saved}yr ${proj.rem_months_saved}mo`
      : `${proj.rem_months_saved}mo`;
    lines.push(`   ${t} earlier than scheduled`);
  }

  lines.push('');
  lines.push(...personWeekLines(d.byPerson));

  return lines.join('\n');
}

async function buildOffsetSummary(db, { mortgageConfig }) {
  const snap = await offsetSnapshot(db, mortgageConfig);
  const saving = await measuredMonthlySaving(db);
  const proj = payoffProjection(mortgageConfig, snap.balance, saving.monthly);

  const lines = [];
  lines.push(`💰 <b>${fmt2(snap.balance)}</b> in the offset`);
  lines.push('');
  lines.push(`Saving ${fmt(snap.monthly_interest_saved)}/mo (${fmt(snap.annual_interest_saved)}/yr) in interest`);
  lines.push(`Mortgage owing ${fmt(proj.current_balance)} at ${pct(mortgageConfig.ratePercent)}`);
  lines.push(`Repayment ${fmt(mortgageConfig.monthlyPayment)}/mo`);
  lines.push('');
  if (snap.goals.length) {
    lines.push('<b>Buckets</b>');
    for (const g of snap.goals) {
      const p = g.target_amount > 0 ? Math.round((g.current_amount / g.target_amount) * 100) : 0;
      lines.push(`   ${g.name}  ${fmt(g.current_amount)} / ${fmt(g.target_amount)} (${p}%)`);
    }
    lines.push(`   <i>unallocated ${fmt(snap.unallocated)}</i>`);
    lines.push('');
  }
  lines.push(`Mortgage-free <b>${proj.payoff_date.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })}</b>`);
  if (proj.months_saved > 0) {
    const t = proj.years_saved > 0 ? `${proj.years_saved}yr ${proj.rem_months_saved}mo` : `${proj.rem_months_saved}mo`;
    lines.push(`${t} ahead of the original schedule`);
  }
  return lines.join('\n');
}

async function buildSpendSummary(db, days, { nonSpending }) {
  const since = daysAgo(days);
  const s = await spendingSince(db, since, nonSpending);
  const label = days === 1 ? 'today' : `last ${days} days`;

  const lines = [`<b>Spending — ${label}</b>`, ''];
  if (s.total === 0) {
    lines.push('Nothing logged.');
    return lines.join('\n');
  }
  lines.push(`Total <b>${fmt2(s.total)}</b>`);
  lines.push(`Averaging ${fmt(s.total / days)}/day`);
  lines.push('');
  for (const c of s.byCategory.slice(0, 8)) {
    lines.push(`   ${c.category.padEnd(16, ' ')} ${fmt(c.total)}  (${c.count})`);
  }
  return lines.join('\n');
}

module.exports = {
  buildDigestData,
  buildDigestCaption,
  buildWeekByPerson,
  buildDailyDigest,
  buildOffsetSummary,
  buildSpendSummary,
  offsetSnapshot,
  offsetFlow,
  measuredMonthlySaving,
  payoffProjection,
  fmt,
  fmt2,
};
