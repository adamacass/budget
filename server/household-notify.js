// Tells the other person when one of you adds money or spending in the app.
//
// One Express middleware rather than a call in every route: it watches the
// routes below, and once a request has succeeded it sends a one-line note to
// the Telegram chats of everyone except the person who made the change. A
// batch (a statement import, say) is one note, not one per row.
//
// The bot's own paths (expenses, screenshots, /withdraw, /deposit) notify from
// telegram.js, and offset withdrawals from the app go through
// notifyOffsetMovement in index.js, so neither is listed here.

const { fmt2, fmt } = require('./digest');

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const num = v => parseFloat(String(v ?? '').replace(/[$,]/g, '')) || 0;
const sum = (rows, key) => (rows || []).reduce((s, r) => s + num(r[key]), 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const descOf = (desc, cat) => [desc && esc(desc), cat && `<i>${esc(cat)}</i>`].filter(Boolean).join(' · ');

// [method, path pattern, (who, body, result, req) => text or null]
const ROUTES = [
  ['POST', /^\/api\/expenses$/, (who, b) => b.entry_type && b.entry_type !== 'actual'
    ? `📝 ${who} added a budget estimate: <b>${fmt2(num(b.amount))}</b> ${descOf(b.description, b.category)}`
    : `💸 ${who} added <b>${fmt2(num(b.amount))}</b> ${descOf(b.description, b.category)}`],
  ['POST', /^\/api\/quick-add$/, (who, b, r) =>
    `💸 ${who} added <b>${fmt2(num(r?.amount ?? b.amount))}</b> ${descOf(r?.description ?? b.description, r?.category ?? b.category)}`],
  ['POST', /^\/api\/expenses\/batch$/, (who, b) => (b.expenses || []).length
    ? `💸 ${who} added ${plural(b.expenses.length, 'expense')}, <b>${fmt2(sum(b.expenses, 'amount'))}</b>` : null],
  ['POST', /^\/api\/statements\/import$/, (who, b, r) => {
    const n = r?.added ?? (b.transactions || []).length;
    return n ? `📄 ${who} imported ${plural(n, 'transaction')} from a statement` +
      (n === (b.transactions || []).length ? `, <b>${fmt2(sum(b.transactions, 'amount'))}</b>` : '') : null;
  }],
  ['POST', /^\/api\/screenshots\/import$/, (who, b, r) => r?.added
    ? `📷 ${who} added ${plural(r.added, 'transaction')} from a screenshot` : null],
  ['POST', /^\/api\/income$/, (who, b) =>
    `💵 ${who} logged pay of <b>${fmt2(num(b.net_amount || b.amount))}</b>${b.pay_date ? ` (${esc(b.pay_date)})` : ''}`],
  ['POST', /^\/api\/payday\/complete$/, (who, b, r, req, names) => {
    const forWho = b.for_user_id && b.for_user_id !== req.user.id ? ` for ${esc(names.get(Number(b.for_user_id)) || 'the other account')}` : '';
    const offset = num(b.offset_amount);
    return `💵 ${who} recorded a pay day${forWho}: <b>${fmt2(num(b.net_amount))}</b> net` +
      (offset > 0 ? `, <b>${fmt2(offset)}</b> into the offset` : '');
  }],
  ['POST', /^\/api\/offset\/reset$/, (who, b) =>
    `🏦 ${who} set the offset balance to <b>${fmt2(num(b.balance))}</b>${b.note ? ` — ${esc(b.note)}` : ''}`],
  ['PUT', /^\/api\/balances\/([^/]+)$/, (who, b, r, req) =>
    `🏦 ${who} updated the ${esc(req.params?.account || req.path.split('/').pop()).replace(/_/g, ' ')} balance to <b>${fmt2(num(b.balance))}</b>`],
  ['POST', /^\/api\/allocations$/, (who, b) => (b.allocations || []).length
    ? `🏦 ${who} allocated <b>${fmt2(sum(b.allocations, 'amount'))}</b> to ${[...new Set(b.allocations.map(a => esc(a.target_account)))].join(', ')}` : null],
  ['POST', /^\/api\/goals$/, (who, b) =>
    `🎯 ${who} started a bucket: <b>${esc(b.name)}</b>, target ${fmt(num(b.target_amount))}`],
  ['PUT', /^\/api\/goals\/\d+$/, (who, b, r) => (b.current_amount !== undefined || b.target_amount !== undefined) && r?.name
    ? `🎯 ${who} updated the <b>${esc(r.name)}</b> bucket: ${fmt(num(r.current_amount))} of ${fmt(num(r.target_amount))}` : null],
  ['POST', /^\/api\/goals\/redistribute$/, (who) => `🎯 ${who} rearranged the offset buckets`],
  ['POST', /^\/api\/upcoming-expenses$/, (who, b) =>
    `📅 ${who} flagged an upcoming expense: <b>${esc(b.description)}</b>, about ${fmt(num(b.estimated_amount))}${b.expected_date ? ` on ${esc(b.expected_date)}` : ''}`],
  ['POST', /^\/api\/planned-withdrawals$/, (who, b) =>
    `📅 ${who} planned a withdrawal: <b>${esc(b.label)}</b>, ${fmt(num(b.amount))}${b.target_date ? ` by ${esc(b.target_date)}` : ''}`],
  ['POST', /^\/api\/backup\/restore$/, (who) => `♻️ ${who} restored the budget from a backup`],
];

function householdNotify({ getDb, telegram }) {
  return (req, res, next) => {
    const route = ROUTES.find(([m, re]) => m === req.method && re.test(req.path));
    if (!route || !telegram.isConfigured()) return next();

    // Keep what the route sent back, for counts the request body doesn't have
    const json = res.json.bind(res);
    res.json = (body) => { res.locals.notifyResult = body; return json(body); };

    res.on('finish', () => {
      if (res.statusCode >= 400 || !req.user?.id) return;
      (async () => {
        const db = await getDb();
        const users = (await db.query('SELECT id, display_name FROM users')).rows;
        const names = new Map(users.map(u => [u.id, u.display_name]));
        const who = `<b>${esc(names.get(req.user.id) || 'Someone')}</b>`;
        const text = route[2](who, req.body || {}, res.locals.notifyResult, req, names);
        if (text) await telegram.notifyHousehold(db, req.user.id, text);
      })().catch(err => console.error(`[notify] ${req.method} ${req.path}: ${err.message}`));
    });
    next();
  };
}

module.exports = { householdNotify, ROUTES };
