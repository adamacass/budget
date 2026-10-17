// Bills sent to the Telegram bot: comparison with the last one, saving,
// reminders and the "Bills" list.
//
// A bill arrives through the screenshot flow (screenshots.js), which reads it
// and shows it for review alongside any banking screenshots. Saving stores the
// bill with its original image or PDF, adds an upcoming_expenses row so the app
// sees it, and sends the other person the bill. Both people are reminded a few
// days before it's due and on the day.

const { fmt, fmt2 } = require('./digest');

const REMIND_DAYS_BEFORE = 3;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function localDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'Australia/Sydney' });
}
function niceDate(iso) {
  if (!iso) return 'no due date';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
}
function monthYear(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}

// "AGL Energy Ltd" and "AGL ENERGY" are the same biller
function billerKey(name) {
  return String(name || '').toLowerCase()
    .replace(/\b(pty|ltd|limited|australia|aust|group|services|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// The most recent earlier bill from the same biller, and how this one compares.
// Compares per day as well when both bills show a billing period, so a longer
// quarter doesn't look like a price rise.
async function compareWithLast(db, { biller, amount, period_start, period_end, excludeId = null }) {
  if (!(amount > 0)) return null;
  const key = billerKey(biller);
  if (!key) return null;
  const rows = (await db.query(
    `SELECT id, biller, amount, due_date, period_start, period_end, created_at FROM bills
     WHERE amount > 0 AND ($1::int IS NULL OR id <> $1) ORDER BY COALESCE(due_date, created_at::date::text) DESC LIMIT 200`,
    [excludeId]
  )).rows;
  const last = rows.find(r => {
    const k = billerKey(r.biller);
    return k === key || (k.length >= 4 && key.length >= 4 && (k.startsWith(key) || key.startsWith(k)));
  });
  if (!last) return null;

  const prev = parseFloat(last.amount);
  const diff = amount - prev;
  const pct = prev > 0 ? (diff / prev) * 100 : 0;
  const when = last.due_date ? monthYear(last.due_date) : monthYear(last.created_at.toISOString().slice(0, 10));

  let perDay = null;
  const days = period_start && period_end ? daysBetween(period_start, period_end) + 1 : null;
  if (days > 0) {
    const prevDays = last.period_start && last.period_end ? daysBetween(last.period_start, last.period_end) + 1 : null;
    if (prevDays > 0) perDay = { now: amount / days, before: prev / prevDays, days, prevDays };
  }

  const arrow = Math.abs(pct) < 1 ? '≈ same as' : diff > 0 ? `▲ ${fmt(Math.abs(diff))} (${Math.abs(pct).toFixed(0)}%) on` : `▼ ${fmt(Math.abs(diff))} (${Math.abs(pct).toFixed(0)}%) on`;
  let text = `${arrow} last time (${fmt2(prev)}, ${when})`;
  if (perDay && perDay.days !== perDay.prevDays) {
    text += `; per day ${fmt2(perDay.now)} vs ${fmt2(perDay.before)} (${perDay.days} vs ${perDay.prevDays} days)`;
  }
  return { text, prev, diff, pct, perDay };
}

// A one-line description of a bill, used in the review list and messages
function billLine(b) {
  const parts = [`🧾 <b>${esc(b.biller)}</b>`, b.amount != null ? fmt2(b.amount) : 'amount not shown', `due ${niceDate(b.due_date)}`];
  return parts.join('  ');
}

async function isDuplicate(db, b) {
  return !!(await db.query(
    `SELECT 1 FROM bills WHERE lower(biller) = lower($1)
     AND COALESCE(ROUND(amount::numeric, 2), -1) = COALESCE(ROUND($2::numeric, 2), -1)
     AND COALESCE(due_date, '') = COALESCE($3::text, '') LIMIT 1`,
    [b.biller, b.amount, b.due_date]
  )).rows[0];
}

// Inside the caller's transaction
async function saveBill(client, userId, b) {
  const upcoming = (await client.query(
    `INSERT INTO upcoming_expenses (user_id, description, estimated_amount, expected_date, category, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, `${b.biller} bill`, b.amount || 0, b.due_date || localDate(14), b.category || 'Utilities',
      b.reference ? `Ref: ${b.reference}` : 'From a bill sent to the bot']
  )).rows[0];
  const bill = (await client.query(
    `INSERT INTO bills (user_id, biller, amount, due_date, reference, category, period_start, period_end, file, file_type, upcoming_expense_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [userId, b.biller, b.amount, b.due_date, b.reference, b.category, b.period_start || null, b.period_end || null,
      b.file || null, b.fileType || null, upcoming.id]
  )).rows[0];
  return bill.id;
}

async function getBill(db, id) {
  return (await db.query(
    'SELECT b.*, u.display_name FROM bills b JOIN users u ON u.id = b.user_id WHERE b.id = $1', [id]
  )).rows[0] || null;
}

async function markPaid(db, id, userId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const b = (await client.query('UPDATE bills SET paid_at = NOW(), paid_by = $2 WHERE id = $1 AND paid_at IS NULL RETURNING *', [id, userId])).rows[0];
    if (b?.upcoming_expense_id) await client.query('UPDATE upcoming_expenses SET resolved = 1 WHERE id = $1', [b.upcoming_expense_id]);
    await client.query('COMMIT');
    return b || null;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function unpaid(db) {
  return (await db.query(
    `SELECT b.id, b.biller, b.amount, b.due_date, b.reference, u.display_name FROM bills b
     JOIN users u ON u.id = b.user_id WHERE b.paid_at IS NULL ORDER BY b.due_date NULLS LAST, b.id`
  )).rows.map(r => ({ ...r, amount: r.amount == null ? null : parseFloat(r.amount) }));
}

// For the daily update caption
async function dueSoonLines(db, days = 7) {
  const until = localDate(days);
  const rows = (await unpaid(db)).filter(b => b.due_date && b.due_date <= until);
  if (!rows.length) return [];
  const today = localDate(0);
  return [
    '<b>🧾 Bills due this week</b>',
    ...rows.map(b => `   ${esc(b.biller)} ${b.amount != null ? fmt2(b.amount) : ''}  ${b.due_date < today ? '<b>overdue</b>' : b.due_date === today ? '<b>today</b>' : niceDate(b.due_date)}`),
  ];
}

// Bills that need a reminder now: REMIND_DAYS_BEFORE days out, and on (or
// after) the due date. Each reminder is sent once.
async function dueReminders(db) {
  const today = localDate(0);
  const early = localDate(REMIND_DAYS_BEFORE);
  const rows = (await db.query(
    `SELECT id, biller, amount, due_date, reference, reminded_early, reminded_due FROM bills
     WHERE paid_at IS NULL AND due_date IS NOT NULL
       AND ((reminded_due = 0 AND due_date <= $1) OR (reminded_early = 0 AND due_date <= $2 AND due_date > $1))`,
    [today, early]
  )).rows;
  return rows.map(r => ({ ...r, amount: r.amount == null ? null : parseFloat(r.amount), kind: r.due_date <= today ? 'due' : 'early' }));
}

async function markReminded(db, id, kind) {
  await db.query(`UPDATE bills SET ${kind === 'due' ? 'reminded_due = 1, reminded_early = 1' : 'reminded_early = 1'} WHERE id = $1`, [id]);
}

module.exports = {
  compareWithLast, billLine, isDuplicate, saveBill, getBill, markPaid, unpaid, dueSoonLines,
  dueReminders, markReminded, niceDate, localDate, esc,
};
