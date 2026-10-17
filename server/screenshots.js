// Banking screenshots sent to the Telegram bot.
//
// Screenshots arriving close together (an album, or several sent one after
// another) are read together into one batch. The bot replies with a numbered
// list and a per-screenshot report; nothing is saved until Save is tapped.
// While a batch is waiting, a text reply such as "3 is groceries, remove 5" is
// read as fixes to the list. Discard deletes the whole exchange from the chat.
//
// Spending-account screenshots become expenses. Offset-account screenshots
// (e.g. NAB's offset screen) become offset deposits and withdrawals, and the
// balance on the screen becomes the offset balance when the batch is saved.

const { categorizeBatch } = require('./categorize');

const COLLECT_MS = 2500;              // wait this long after the last photo before reading
const BATCH_TTL_MS = 30 * 60 * 1000;
const MAX_MESSAGE_CHARS = 3800;

const batches = new Map();            // chatId -> pending batch awaiting Save/Discard
const incoming = new Map();           // chatId -> photos still arriving

let ctx = null;                       // { callTelegram, sendMessage, logActivity, notifyOthers, getDeps, apiBase, token }

function init(context) { ctx = context; }

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function money(n) {
  return '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function shortDate(iso) {
  if (!iso) return '?';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}`;
}
function normDesc(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function deleteMessages(chatId, ids) {
  return Promise.all([...new Set(ids)].filter(Boolean).map(id =>
    ctx.callTelegram('deleteMessage', { chat_id: chatId, message_id: id }, { timeoutMs: 15000 }).catch(() => {})
  ));
}

function hasPending(chatId) {
  const b = batches.get(String(chatId));
  if (b && Date.now() - b.updatedAt > BATCH_TTL_MS) batches.delete(String(chatId));
  return batches.has(String(chatId));
}

// --- receiving -------------------------------------------------------------

// A Telegram photo, or an image sent as a file (uncompressed)
function imageOf(msg) {
  if (msg.photo && msg.photo.length) return { file_id: msg.photo[msg.photo.length - 1].file_id };
  if (msg.document && /^image\//.test(msg.document.mime_type || '')) {
    return { file_id: msg.document.file_id, mime: msg.document.mime_type };
  }
  return null;
}

async function onPhoto(db, link, msg) {
  const chatId = String(msg.chat.id);
  const img = imageOf(msg);
  if (!img) return false;

  let buf = incoming.get(chatId);
  if (!buf) {
    buf = { photos: [], link, timer: null, statusId: null };
    incoming.set(chatId, buf);
    const status = await ctx.sendMessage(chatId, '📷 Reading…').catch(() => null);
    buf.statusId = status?.message_id || null;
  }
  buf.photos.push({ ...img, message_id: msg.message_id });

  clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    incoming.delete(chatId);
    readBatch(db, chatId, buf).catch(async err => {
      console.error('[screenshots] batch failed:', err.message);
      await ctx.sendMessage(chatId, `Something went wrong reading those: ${esc(err.message)}`).catch(() => {});
    });
  }, COLLECT_MS);
  return true;
}

async function download(fileId) {
  const file = await ctx.callTelegram('getFile', { file_id: fileId }, { timeoutMs: 20000 });
  const res = await fetch(`${ctx.apiBase}/file/bot${ctx.token()}/${file.file_path}`);
  if (!res.ok) throw new Error(`could not download it (${res.status})`);
  const data = Buffer.from(await res.arrayBuffer()).toString('base64');
  const mediaType = /\.png$/i.test(file.file_path) ? 'image/png'
    : /\.webp$/i.test(file.file_path) ? 'image/webp' : 'image/jpeg';
  return { data, mediaType };
}

// --- reading ---------------------------------------------------------------

async function readBatch(db, chatId, buf) {
  const deps = ctx.getDeps();
  const existing = batches.get(chatId);
  const batch = existing || {
    id: `${chatId}-${Date.now()}`,
    chatId,
    userId: buf.link.user_id,
    displayName: buf.link.display_name,
    items: [],
    reports: [],
    balance: null,
    previewIds: [],
    chatMessageIds: [],
    createdAt: Date.now(),
  };
  batch.chatMessageIds.push(...buf.photos.map(p => p.message_id), buf.statusId);

  const firstShot = batch.reports.length + 1;
  const reads = await Promise.all(buf.photos.map(async (p, k) => {
    try {
      const img = await download(p.file_id);
      return { shot: firstShot + k, ...(await deps.claude.extractTransactionsFromImage(img.data, p.mime || img.mediaType)) };
    } catch (e) {
      return { shot: firstShot + k, error: e.message };
    }
  }));

  const spending = [];
  for (const r of reads) {
    if (r.error) {
      batch.reports.push({ shot: r.shot, error: r.error });
      continue;
    }
    const isOffset = r.account_kind === 'offset';
    batch.reports.push({
      shot: r.shot, count: r.transactions.length, offset: isOffset,
      name: r.account_name, balance: r.balance,
    });
    if (isOffset && r.balance != null) batch.balance = { value: r.balance, shot: r.shot };

    for (const t of r.transactions) {
      const item = {
        shot: r.shot,
        date: deps.parseDate(t.date) || new Date().toISOString().split('T')[0],
        description: String(t.description || '').trim() || 'Transaction',
        amount: Math.abs(parseFloat(String(t.amount).replace(/[$,]/g, ''))) || 0,
        status: 'new',
        reason: null,
      };
      if (!item.amount) continue;
      if (isOffset) {
        item.kind = t.direction === 'in' ? 'offset_in' : 'offset_out';
        if (item.kind === 'offset_out' && /home\s*loan|loan\s*repay|mortgage|repayment/i.test(item.description)) {
          item.status = 'skip'; item.reason = 'loan repayment, already tracked';
        }
      } else {
        item.kind = 'expense';
        if (t.direction === 'in') { item.status = 'skip'; item.reason = 'money in, not spending'; }
        spending.push(item);
      }
      batch.items.push(item);
    }
  }

  // Categorise new spending in one call
  const toCat = spending.filter(i => i.status === 'new' || i.reason === 'money in, not spending');
  if (toCat.length) {
    const cats = await categorizeBatch(db, toCat.map(i => i.description));
    toCat.forEach((i, k) => {
      i.category = cats[k].category;
      i.confidence = cats[k].confidence;
      if (i.status === 'new' && deps.nonSpending.includes(i.category)) {
        i.status = 'skip'; i.reason = 'transfer, not spending';
      }
    });
  }

  await markDuplicates(db, batch);
  batch.updatedAt = Date.now();
  batches.set(chatId, batch);
  await showPreview(batch);
}

// Screenshots overlap, and the same money may already be in the app
async function markDuplicates(db, batch) {
  // Compare against everything already in the batch, but only mark newly read items
  const seen = new Map();
  batch.items.forEach((item, idx) => {
    const key = `${item.kind}|${item.date}|${item.amount}|${normDesc(item.description)}`;
    if (!seen.has(key)) { seen.set(key, idx); return; }
    if (item.status === 'new' && !item.checked) {
      item.status = 'skip'; item.reason = `same as ${seen.get(key) + 1}`;
    }
  });

  for (const item of batch.items) {
    if (item.status !== 'new' || item.checked) continue;
    item.checked = true;
    if (item.kind === 'expense') {
      const hit = (await db.query(
        `SELECT 1 FROM expenses WHERE amount = $1 AND expense_date = $2
         AND (lower(description) = lower($3) OR (user_id = $4 AND regexp_replace(lower(description), '[^a-z0-9]', '', 'g') = $5))
         LIMIT 1`,
        [item.amount, item.date, item.description, batch.userId, normDesc(item.description)]
      )).rows[0];
      if (hit) { item.status = 'skip'; item.reason = 'already logged'; }
    } else {
      const signed = item.kind === 'offset_in' ? -item.amount : item.amount;
      const hit = (await db.query(
        `SELECT 1 FROM offset_withdrawals
         WHERE amount = $1 AND withdrawal_date::date BETWEEN $2::date - 3 AND $2::date + 3 LIMIT 1`,
        [signed, item.date]
      )).rows[0];
      const payHit = item.kind === 'offset_in' && (await db.query(
        `SELECT 1 FROM income_entries
         WHERE ABS(COALESCE(offset_transfer, 0) - $1) < 0.01 AND pay_date::date BETWEEN $2::date - 3 AND $2::date + 3 LIMIT 1`,
        [item.amount, item.date]
      )).rows[0];
      if (hit || payHit) { item.status = 'skip'; item.reason = payHit ? 'already recorded as a pay day' : 'already recorded'; }
    }
  }
}

// --- showing ---------------------------------------------------------------

function counts(batch) {
  const live = batch.items.filter(i => i.status === 'new');
  return {
    expenses: live.filter(i => i.kind === 'expense'),
    offset: live.filter(i => i.kind !== 'expense'),
    total: live.length + (batch.balance ? 1 : 0),
  };
}

function itemLine(item, n, html) {
  const sign = item.kind === 'offset_in' ? '+' : item.kind === 'offset_out' ? '−' : '';
  const what = item.kind === 'expense' ? (item.category || 'Other') : (item.kind === 'offset_in' ? 'deposit' : 'withdrawal');
  if (!html) {
    return `${n}. ${shortDate(item.date)} ${sign}${money(item.amount)} ${item.description} [${what}]` +
      (item.status === 'skip' ? ` (not saving: ${item.reason})` : '');
  }
  const flag = item.kind === 'expense' && item.confidence === 'low' && item.status === 'new' ? ' ⚠️' : '';
  const body = `${n}. ${shortDate(item.date)}  ${sign}${money(item.amount)}  ${esc(item.description.slice(0, 34))}  <i>${esc(what)}</i>${flag}`;
  return item.status === 'skip' ? `<s>${body}</s>  <i>${esc(item.reason)}</i>` : body;
}

// The list as plain text, for Claude to resolve fixes against
function plainList(batch) {
  const lines = [];
  if (batch.balance) lines.push(`0. Offset balance ${money(batch.balance.value)}`);
  batch.items.forEach((item, i) => lines.push(itemLine(item, i + 1, false)));
  return lines.join('\n');
}

async function showPreview(batch, heading) {
  await deleteMessages(batch.chatId, batch.previewIds);
  batch.previewIds = [];

  const c = counts(batch);
  const lines = [];
  const shots = batch.reports.length;
  lines.push(heading || `📷 <b>${shots} screenshot${shots === 1 ? '' : 's'}</b> from ${esc(batch.displayName)}`);
  for (const r of batch.reports) {
    if (r.error) lines.push(`   #${r.shot}: ❌ couldn't read it (${esc(r.error)})`);
    else lines.push(`   #${r.shot}: ${r.offset ? 'offset' : esc(r.name || 'spending')}, ${r.count} transaction${r.count === 1 ? '' : 's'}${r.balance != null && r.offset ? `, balance ${money(r.balance)}` : ''}`);
  }
  lines.push('');

  if (batch.balance) {
    const cur = (await ctx.getDeps().getDb().then(db => db.query(
      "SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1"
    ))).rows[0];
    const now = cur ? parseFloat(cur.balance) : 0;
    const diff = batch.balance.value - now;
    lines.push(`0. <b>Offset balance → ${money(batch.balance.value)}</b>  <i>(app has ${money(now)}, ${diff >= 0 ? '+' : '−'}${money(Math.abs(diff))})</i>`);
    lines.push('');
  }

  const section = (title, kinds) => {
    const rows = batch.items.map((item, i) => ({ item, n: i + 1 })).filter(r => kinds.includes(r.item.kind));
    if (!rows.length) return;
    lines.push(`<b>${title}</b>`);
    for (const r of rows) lines.push(itemLine(r.item, r.n, true));
    lines.push('');
  };
  section('Spending', ['expense']);
  section('Offset', ['offset_in', 'offset_out']);

  if (!batch.items.length && !batch.balance) {
    lines.push('Nothing I could save from these.');
  } else {
    const parts = [];
    if (c.expenses.length) parts.push(`${c.expenses.length} expense${c.expenses.length === 1 ? '' : 's'} (${money(c.expenses.reduce((s, i) => s + i.amount, 0))})`);
    if (c.offset.length) parts.push(`${c.offset.length} offset movement${c.offset.length === 1 ? '' : 's'}`);
    if (batch.balance) parts.push('the offset balance');
    lines.push(parts.length ? `Will save ${parts.join(', ')}.` : 'Nothing new to save. Everything is already in the app.');
    lines.push('Reply to fix anything, e.g. <code>3 groceries</code>, <code>remove 5</code>, <code>7 is 12.50</code>, <code>include 4</code>.');
  }

  // Split long lists across messages; buttons go on the last one
  const chunks = [];
  let cur = '';
  for (const l of lines) {
    if (cur.length + l.length + 1 > MAX_MESSAGE_CHARS) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + l;
  }
  if (cur) chunks.push(cur);

  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    const buttons = [];
    if (last && c.total) buttons.push({ text: `✅ Save ${c.total}`, callback_data: `import:${batch.id}` });
    if (last) buttons.push({ text: '❌ Discard', callback_data: `discard:${batch.id}` });
    const sent = await ctx.sendMessage(batch.chatId, chunks[i], last ? { reply_markup: { inline_keyboard: [buttons] } } : {});
    if (sent?.message_id) batch.previewIds.push(sent.message_id);
  }
}

// --- fixes -----------------------------------------------------------------

// Returns true if the text was taken as fixes to the pending batch
async function onText(db, link, msg, text) {
  const chatId = String(msg.chat.id);
  const batch = batches.get(chatId);
  if (!batch) return false;
  const deps = ctx.getDeps();

  const categories = (await db.query(
    "SELECT category FROM category_budgets UNION SELECT DISTINCT category FROM expenses WHERE entry_type = 'actual'"
  )).rows.map(r => r.category);
  for (const c of ['Transfer', 'Mortgage', 'Other']) if (!categories.includes(c)) categories.push(c);

  let parsed;
  try {
    parsed = await deps.claude.parseBatchFixes(text, { lines: plainList(batch), categories });
  } catch (e) {
    console.error('[screenshots] fix parse failed:', e.message);
    return false;
  }
  if (!parsed || !parsed.is_fix || !parsed.edits?.length) return false;

  const notes = [];
  for (const e of parsed.edits) {
    if (e.action === 'set_balance') {
      const v = parseFloat(String(e.value).replace(/[$,]/g, ''));
      if (!isNaN(v) && v >= 0) batch.balance = { value: v, shot: batch.balance?.shot || null };
      continue;
    }
    if (e.number === 0 && e.action === 'remove') { batch.balance = null; continue; }
    const item = batch.items[e.number - 1];
    if (!item) { notes.push(`there's no ${e.number}`); continue; }
    switch (e.action) {
      case 'remove': item.status = 'skip'; item.reason = 'removed'; break;
      case 'include': item.status = 'new'; item.reason = null; break;
      case 'set_category':
        if (item.kind === 'expense' && categories.includes(e.value)) { item.category = e.value; item.confidence = 'high'; }
        break;
      case 'set_amount': {
        const v = Math.abs(parseFloat(String(e.value).replace(/[$,]/g, '')));
        if (v) item.amount = Math.round(v * 100) / 100;
        break;
      }
      case 'set_description': if (e.value.trim()) item.description = e.value.trim(); break;
      case 'set_date': { const d = deps.parseDate(e.value); if (d) item.date = d; break; }
    }
  }

  batch.chatMessageIds.push(msg.message_id);
  batch.updatedAt = Date.now();
  await showPreview(batch, `✏️ <b>Updated</b>${notes.length ? ` (${esc(notes.join('; '))})` : ''}`);
  return true;
}

// --- saving ----------------------------------------------------------------

async function onCallback(db, link, cb, action, id) {
  const chatId = String(cb.message?.chat?.id);
  const batch = batches.get(chatId);
  const ack = (text) => ctx.callTelegram('answerCallbackQuery', { callback_query_id: cb.id, text }, { timeoutMs: 15000 }).catch(() => {});

  if (!batch || batch.id !== id) {
    await ack('That batch has expired.');
    await deleteMessages(chatId, [cb.message?.message_id]);
    return;
  }
  batches.delete(chatId);

  if (action === 'discard') {
    await ack('Discarded, nothing saved');
    await deleteMessages(chatId, [...batch.previewIds, ...batch.chatMessageIds]);
    await ctx.logActivity(db, { chatId, userId: link.user_id, direction: 'in', kind: 'screenshot_discard', summary: `${batch.items.length} discarded` });
    return;
  }

  const saved = await save(db, link, batch);
  await ack('Saved');
  await deleteMessages(chatId, batch.previewIds);

  const lines = ['✅ <b>Saved</b>'];
  if (saved.expenses) lines.push(`   ${saved.expenses} expense${saved.expenses === 1 ? '' : 's'}, ${money(saved.expenseTotal)}`);
  if (saved.skipped) lines.push(`   skipped ${saved.skipped} already in the app`);
  if (saved.offsetMoves) lines.push(`   ${saved.offsetMoves} offset movement${saved.offsetMoves === 1 ? '' : 's'}`);
  if (saved.balance != null) lines.push(`   offset balance now <b>${money(saved.balance)}</b>`);
  await ctx.sendMessage(chatId, lines.join('\n'));

  const bits = [];
  if (saved.expenses) bits.push(`${saved.expenses} expense${saved.expenses === 1 ? '' : 's'} (${money(saved.expenseTotal)})`);
  if (saved.offsetMoves) bits.push(`${saved.offsetMoves} offset movement${saved.offsetMoves === 1 ? '' : 's'}`);
  if (saved.balance != null) bits.push(`offset balance ${money(saved.balance)}`);
  if (bits.length) {
    await ctx.notifyOthers(db, chatId, `📷 ${esc(link.display_name)} saved ${bits.join(', ')} from screenshots.`);
  }
}

async function save(db, link, batch) {
  const live = batch.items.filter(i => i.status === 'new');
  const out = { expenses: 0, expenseTotal: 0, skipped: 0, offsetMoves: 0, balance: null };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const item of live.filter(i => i.kind === 'expense')) {
      const dupe = (await client.query(
        'SELECT 1 FROM expenses WHERE user_id = $1 AND description = $2 AND amount = $3 AND expense_date = $4 LIMIT 1',
        [link.user_id, item.description, item.amount, item.date]
      )).rows[0];
      if (dupe) { out.skipped++; continue; }
      await client.query(
        `INSERT INTO expenses (user_id, category, subcategory, description, amount, expense_date, entry_type)
         VALUES ($1, $2, 'telegram', $3, $4, $5, 'actual')`,
        [link.user_id, item.category || 'Other', item.description, item.amount, item.date]
      );
      out.expenses++;
      out.expenseTotal += item.amount;
    }

    const moves = live.filter(i => i.kind !== 'expense');
    let net = 0;
    for (const item of moves) {
      // Same convention as /deposit and /withdraw: a deposit is a negative withdrawal
      const signed = item.kind === 'offset_in' ? -item.amount : item.amount;
      await client.query(
        "INSERT INTO offset_withdrawals (user_id, amount, withdrawal_date, reason, category) VALUES ($1, $2, $3, $4, 'Other')",
        [link.user_id, signed, item.date, item.description]
      );
      net += signed;
      out.offsetMoves++;
    }

    if (batch.balance || moves.length) {
      const prev = (await client.query(
        "SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1"
      )).rows[0];
      const prevBalance = prev ? parseFloat(prev.balance) : 0;
      // The bank's figure is the truth when the screenshot shows it
      const balance = batch.balance
        ? batch.balance.value
        : Math.max(0, Math.round((prevBalance - net) * 100) / 100);
      await client.query(
        "INSERT INTO account_balances (account_type, balance, updated_by, note, source) VALUES ('offset', $1, $2, $3, 'screenshot')",
        [balance, link.user_id, batch.balance ? 'Balance from banking screenshot' : 'Offset movements from banking screenshot']
      );
      out.balance = balance;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await ctx.logActivity(db, {
    chatId: batch.chatId, userId: link.user_id, direction: 'in', kind: 'screenshot_import',
    summary: `${out.expenses} expenses, ${out.offsetMoves} offset movements${out.balance != null ? `, balance ${out.balance}` : ''}`,
  });
  return out;
}

function sweep() {
  const now = Date.now();
  for (const [k, b] of batches) if (now - b.updatedAt > BATCH_TTL_MS) batches.delete(k);
}

module.exports = { init, onPhoto, onText, onCallback, hasPending, imageOf, sweep, _batches: batches };
