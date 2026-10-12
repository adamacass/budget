// Telegram bot — runs inside the app container, talks to Telegram by long
// polling. Polling (rather than webhooks) is what makes this work on a home
// desktop: Telegram never needs to reach you, so there is no public URL, no
// port forwarding and no tunnel involved.
//
// Nothing happens for a chat until it is linked to an app user with a one-time
// code generated in the admin UI. Unlinked chats get a single instruction and
// are otherwise ignored.

// Overridable so the bot loop can be exercised against a stub in tests.
const API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

let state = {
  running: false,
  stopping: false,
  offset: 0,
  me: null,
  startedAt: null,
  lastPollAt: null,
  lastError: null,
  pollFailures: 0,
};

// Pending screenshot extractions awaiting a Confirm tap, keyed by chat id
const pendingImports = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

let deps = null;
// Module-scoped so every handler can format money, not just handleCommand
let digest = null;

function token() {
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

function isConfigured() {
  return token().length > 0;
}

async function callTelegram(method, body, { timeoutMs = 90000 } = {}) {
  const t = token();
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN is not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/bot${t}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      throw new Error(json.description || `Telegram ${method} failed (${res.status})`);
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function sendMessage(chatId, text, extra = {}) {
  // Telegram caps messages at 4096 characters
  const body = text.length > 4000 ? text.slice(0, 3990) + '\n…' : text;
  return callTelegram('sendMessage', {
    chat_id: chatId,
    text: body,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  }, { timeoutMs: 20000 });
}

async function logActivity(db, { chatId, userId, direction, kind, summary }) {
  try {
    await db.query(
      'INSERT INTO bot_activity (chat_id, user_id, direction, kind, summary) VALUES ($1, $2, $3, $4, $5)',
      [chatId ? String(chatId) : null, userId || null, direction, kind, (summary || '').slice(0, 500)]
    );
  } catch (e) { /* logging must never break the bot */ }
}

async function getLink(db, chatId) {
  return (await db.query(
    `SELECT l.*, u.display_name FROM telegram_links l
     JOIN users u ON l.user_id = u.id
     WHERE l.chat_id = $1 AND l.active = 1`, [String(chatId)]
  )).rows[0] || null;
}

// --- parsing ---------------------------------------------------------------

// "42.50 woolies", "woolies 42.50", "$12 coffee", "coffee $12.30"
function parseExpenseMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const amountRe = /(?:^|\s)\$?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?:\s|$)/;
  const m = raw.match(amountRe);
  if (!m) return null;

  const amount = parseFloat(m[1].replace(/,/g, ''));
  if (!amount || isNaN(amount) || amount <= 0) return null;

  const description = (raw.slice(0, m.index) + ' ' + raw.slice(m.index + m[0].length))
    .replace(/\s+/g, ' ')
    .replace(/^[-–—:,]+|[-–—:,]+$/g, '')
    .trim();

  return { amount, description: description || 'Expense' };
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// --- handlers --------------------------------------------------------------

const HELP = [
  '<b>What I can do</b>',
  '',
  '<b>Log an expense</b> — just send it:',
  '   <code>42.50 woolies</code>',
  '   <code>coffee 6.20</code>',
  '',
  '<b>Send a screenshot</b> of your banking app and I\'ll read the',
  'transactions, categorise them and ask before saving.',
  '',
  '<b>Commands</b>',
  '/offset — balance, buckets, payoff date',
  '/today — today\'s spending',
  '/week — last 7 days',
  '/month — last 30 days',
  '/digest — the full daily update now',
  '/withdraw 500 new tyres — record money out of the offset',
  '/deposit 500 refund — record money in',
  '/undo — remove the last thing I added',
  '/mute /unmute — turn the daily digest off and on',
  '/help — this message',
].join('\n');

async function handleCommand(db, link, chatId, text) {
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, '');
  const args = rest.join(' ');
  const { getMortgageConfig, nonSpending } = deps;

  switch (cmd) {
    case '/start':
    case '/help':
      return sendMessage(chatId, HELP);

    case '/offset': {
      const mc = await getMortgageConfig(db);
      return sendMessage(chatId, await digest.buildOffsetSummary(db, { mortgageConfig: mc }));
    }

    case '/today':
      return sendMessage(chatId, await digest.buildSpendSummary(db, 1, { nonSpending }));
    case '/week':
      return sendMessage(chatId, await digest.buildSpendSummary(db, 7, { nonSpending }));
    case '/month':
      return sendMessage(chatId, await digest.buildSpendSummary(db, 30, { nonSpending }));

    case '/digest': {
      const mc = await getMortgageConfig(db);
      return sendMessage(chatId, await digest.buildDailyDigest(db, { mortgageConfig: mc, nonSpending }));
    }

    case '/withdraw':
    case '/deposit': {
      const parsed = parseExpenseMessage(args);
      if (!parsed) {
        return sendMessage(chatId, `Give me an amount, e.g. <code>${cmd} 500 new tyres</code>`);
      }
      const isDeposit = cmd === '/deposit';
      const result = await deps.recordOffsetMovement(db, {
        userId: link.user_id,
        amount: parsed.amount,
        reason: parsed.description === 'Expense' ? null : parsed.description,
        deposit: isDeposit,
      });
      await logActivity(db, {
        chatId, userId: link.user_id, direction: 'in', kind: isDeposit ? 'deposit' : 'withdrawal',
        summary: `${digest.fmt2(parsed.amount)} ${parsed.description}`,
      });
      return sendMessage(chatId,
        `${isDeposit ? '⬆️ Deposit' : '⬇️ Withdrawal'} of <b>${digest.fmt2(parsed.amount)}</b> recorded.\n` +
        `Offset is now <b>${digest.fmt(result.balance)}</b>.`);
    }

    case '/undo': {
      const last = (await db.query(
        `SELECT id, description, amount FROM expenses
         WHERE user_id = $1 AND subcategory = 'telegram'
         ORDER BY id DESC LIMIT 1`, [link.user_id]
      )).rows[0];
      if (!last) return sendMessage(chatId, 'Nothing of mine to undo.');
      await db.query('DELETE FROM expenses WHERE id = $1', [last.id]);
      return sendMessage(chatId, `Removed ${digest.fmt2(last.amount)} ${last.description || ''}`.trim());
    }

    case '/mute':
      await db.query('UPDATE telegram_links SET digest_enabled = 0 WHERE chat_id = $1', [String(chatId)]);
      return sendMessage(chatId, 'Daily digest off. /unmute to turn it back on.');
    case '/unmute':
      await db.query('UPDATE telegram_links SET digest_enabled = 1 WHERE chat_id = $1', [String(chatId)]);
      return sendMessage(chatId, 'Daily digest on.');

    default:
      return sendMessage(chatId, `Don't know <code>${cmd}</code>. /help for the list.`);
  }
}

// An unlinked chat can only do one thing: redeem a code
async function handleLinking(db, chatId, text, from) {
  const match = String(text || '').trim().match(/^\/link\s+([A-Za-z0-9-]{4,})$/);
  if (!match) {
    return sendMessage(chatId,
      'This chat isn\'t linked to the budget yet.\n\n' +
      'Open the budget app → <b>Admin → Telegram</b>, generate a link code, then send it here as:\n' +
      '<code>/link YOUR-CODE</code>');
  }

  const code = match[1].toUpperCase();
  const row = (await db.query(
    `SELECT c.*, u.display_name FROM telegram_link_codes c
     JOIN users u ON c.user_id = u.id
     WHERE UPPER(c.code) = $1 AND c.used_at IS NULL AND c.expires_at > NOW()`, [code]
  )).rows[0];

  if (!row) {
    return sendMessage(chatId, 'That code is wrong, already used, or expired. Generate a fresh one in the admin UI.');
  }

  await db.query('UPDATE telegram_link_codes SET used_at = NOW() WHERE id = $1', [row.id]);
  await db.query(
    `INSERT INTO telegram_links (chat_id, user_id, telegram_username, first_name, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (chat_id) DO UPDATE SET user_id = EXCLUDED.user_id, active = 1,
       telegram_username = EXCLUDED.telegram_username, first_name = EXCLUDED.first_name`,
    [String(chatId), row.user_id, from?.username || null, from?.first_name || null]
  );
  await logActivity(db, { chatId, userId: row.user_id, direction: 'in', kind: 'link', summary: `Linked to ${row.display_name}` });

  return sendMessage(chatId, `✅ Linked to <b>${row.display_name}</b>.\n\n${HELP}`);
}

async function handlePhoto(db, link, chatId, photos) {
  const { claude, categorize, getCategoryRules } = deps;

  // Telegram sends several sizes; the last is the largest
  const best = photos[photos.length - 1];
  await sendMessage(chatId, '📷 Reading…');

  const file = await callTelegram('getFile', { file_id: best.file_id }, { timeoutMs: 20000 });
  const url = `${API}/file/bot${token()}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the image (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const base64 = buf.toString('base64');
  const mediaType = file.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg';

  const result = await claude.extractTransactionsFromImage(base64, mediaType);
  if (result.error) {
    return sendMessage(chatId, `Couldn't read that: ${result.error}`);
  }
  const txns = Array.isArray(result.transactions) ? result.transactions : [];
  if (!txns.length) {
    return sendMessage(chatId, 'No transactions found in that image.');
  }

  const rules = await getCategoryRules();
  const items = txns.map(t => {
    const { category, confidence } = categorize(t.description || '', rules);
    return {
      description: t.description || 'Expense',
      amount: parseFloat(String(t.amount).replace(/[$,]/g, '')) || 0,
      date: t.date,
      category,
      confidence,
    };
  }).filter(t => t.amount > 0 && category_is_spending(t.category));

  if (!items.length) {
    return sendMessage(chatId, 'Found only transfers or unreadable amounts — nothing to add.');
  }

  const id = `${chatId}-${Date.now()}`;
  pendingImports.set(String(chatId), { id, items, createdAt: Date.now() });

  const total = items.reduce((s, t) => s + t.amount, 0);
  const lines = [`Found <b>${items.length}</b> transaction${items.length === 1 ? '' : 's'} totalling <b>${digest.fmt2(total)}</b>:`, ''];
  for (const t of items.slice(0, 15)) {
    const flag = t.confidence === 'low' ? ' ⚠️' : '';
    lines.push(`• ${digest.fmt2(t.amount)}  ${t.description.slice(0, 32)}  <i>${t.category}</i>${flag}`);
  }
  if (items.length > 15) lines.push(`…and ${items.length - 15} more`);
  lines.push('');
  lines.push('⚠️ = low confidence category, worth checking in the app afterwards.');

  return sendMessage(chatId, lines.join('\n'), {
    reply_markup: {
      inline_keyboard: [[
        { text: `✅ Add all ${items.length}`, callback_data: `import:${id}` },
        { text: '❌ Discard', callback_data: `discard:${id}` },
      ]],
    },
  });
}

function category_is_spending(category) {
  return !(deps.nonSpending || []).includes(category);
}

async function handleCallback(db, cb) {
  const chatId = cb.message?.chat?.id;
  const data = String(cb.data || '');
  const link = await getLink(db, chatId);
  if (!link) return;

  const [action, id] = data.split(':');
  const pending = pendingImports.get(String(chatId));

  const ack = (text) => callTelegram('answerCallbackQuery', { callback_query_id: cb.id, text }, { timeoutMs: 15000 }).catch(() => {});

  if (!pending || pending.id !== id) {
    await ack('That batch has expired.');
    return sendMessage(chatId, 'That batch expired — send the screenshot again.');
  }

  pendingImports.delete(String(chatId));

  if (action === 'discard') {
    await ack('Discarded');
    return sendMessage(chatId, 'Discarded, nothing saved.');
  }

  let added = 0;
  let skipped = 0;
  for (const t of pending.items) {
    const date = deps.parseDate(t.date) || todayStr();
    const dupe = (await db.query(
      'SELECT 1 FROM expenses WHERE user_id = $1 AND description = $2 AND amount = $3 AND expense_date = $4 LIMIT 1',
      [link.user_id, t.description, t.amount, date]
    )).rows[0];
    if (dupe) { skipped++; continue; }
    await db.query(
      `INSERT INTO expenses (user_id, category, subcategory, description, amount, expense_date, entry_type)
       VALUES ($1, $2, 'telegram', $3, $4, $5, 'actual')`,
      [link.user_id, t.category, t.description, t.amount, date]
    );
    added++;
  }

  await ack(`Added ${added}`);
  await logActivity(db, { chatId, userId: link.user_id, direction: 'in', kind: 'screenshot_import', summary: `${added} added, ${skipped} skipped` });

  const total = pending.items.reduce((s, t) => s + t.amount, 0);
  await sendMessage(chatId,
    `✅ Added <b>${added}</b> transaction${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''}.\n` +
    `Total ${digest.fmt2(total)}.`);

  return notifyOthers(db, chatId, `📷 ${link.display_name} added ${added} transaction${added === 1 ? '' : 's'} (${digest.fmt2(total)}) from a screenshot.`);
}

// Tell the *other* linked chats about something, so the household stays in sync
async function notifyOthers(db, originChatId, text) {
  const others = (await db.query(
    'SELECT chat_id FROM telegram_links WHERE active = 1 AND alerts_enabled = 1 AND chat_id <> $1',
    [String(originChatId)]
  )).rows;
  for (const o of others) {
    await sendMessage(o.chat_id, text).catch(() => {});
  }
}

async function handleMessage(db, msg) {
  const chatId = msg.chat?.id;
  if (!chatId) return;
  const text = msg.text || msg.caption || '';

  const link = await getLink(db, chatId);
  if (!link) return handleLinking(db, chatId, text, msg.from);

  await db.query('UPDATE telegram_links SET last_seen_at = NOW() WHERE chat_id = $1', [String(chatId)]);

  if (msg.photo && msg.photo.length) {
    return handlePhoto(db, link, chatId, msg.photo);
  }

  if (text.startsWith('/')) {
    await logActivity(db, { chatId, userId: link.user_id, direction: 'in', kind: 'command', summary: text.slice(0, 100) });
    return handleCommand(db, link, chatId, text);
  }

  // Anything else is treated as an expense
  const parsed = parseExpenseMessage(text);
  if (!parsed) {
    return sendMessage(chatId, "I couldn't find an amount in that. Try <code>42.50 woolies</code>, or /help.");
  }

  const rules = await deps.getCategoryRules();
  const { category, confidence } = deps.categorize(parsed.description, rules);

  await db.query(
    `INSERT INTO expenses (user_id, category, subcategory, description, amount, expense_date, entry_type)
     VALUES ($1, $2, 'telegram', $3, $4, $5, 'actual')`,
    [link.user_id, category, parsed.description, parsed.amount, todayStr()]
  );
  await logActivity(db, {
    chatId, userId: link.user_id, direction: 'in', kind: 'expense',
    summary: `${digest.fmt2(parsed.amount)} ${parsed.description} → ${category}`,
  });

  const hint = confidence === 'low' ? '\n<i>Low confidence on the category — change it in the app if wrong.</i>' : '';
  await sendMessage(chatId,
    `✅ <b>${digest.fmt2(parsed.amount)}</b> — ${parsed.description}\nCategory: <b>${category}</b>${hint}`);

  return notifyOthers(db, chatId, `💸 ${link.display_name} logged ${digest.fmt2(parsed.amount)} — ${parsed.description} (${category})`);
}

// --- polling loop ----------------------------------------------------------

async function pollLoop() {
  const { getDb } = deps;
  while (!state.stopping) {
    try {
      const updates = await callTelegram('getUpdates', {
        offset: state.offset,
        timeout: 50,
        allowed_updates: ['message', 'callback_query'],
      }, { timeoutMs: 70000 });

      state.lastPollAt = new Date().toISOString();
      state.pollFailures = 0;
      state.lastError = null;

      const db = await getDb();
      for (const u of updates) {
        state.offset = u.update_id + 1;
        try {
          if (u.message) await handleMessage(db, u.message);
          else if (u.callback_query) await handleCallback(db, u.callback_query);
        } catch (err) {
          console.error('[telegram] handler error:', err.message);
          const chatId = u.message?.chat?.id || u.callback_query?.message?.chat?.id;
          if (chatId) await sendMessage(chatId, `Something went wrong: ${err.message}`).catch(() => {});
        }
      }

      // Expire stale screenshot batches
      const now = Date.now();
      for (const [k, v] of pendingImports) {
        if (now - v.createdAt > PENDING_TTL_MS) pendingImports.delete(k);
      }
    } catch (err) {
      if (state.stopping) break;
      state.pollFailures++;
      state.lastError = err.message;
      // Back off so a bad token or no network doesn't spin the CPU
      const wait = Math.min(60000, 2000 * Math.pow(2, Math.min(state.pollFailures, 5)));
      console.error(`[telegram] poll failed (${state.pollFailures}): ${err.message} — retrying in ${wait / 1000}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  state.running = false;
}

async function start(dependencies) {
  deps = dependencies;
  digest = dependencies.digest;
  if (!isConfigured()) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — bot disabled');
    return false;
  }
  if (state.running) return true;

  try {
    state.me = await callTelegram('getMe', {}, { timeoutMs: 15000 });
  } catch (err) {
    console.error(`[telegram] could not reach Telegram: ${err.message}`);
    state.lastError = err.message;
    return false;
  }

  state.running = true;
  state.stopping = false;
  state.startedAt = new Date().toISOString();
  console.log(`[telegram] bot @${state.me.username} polling`);
  pollLoop();
  return true;
}

function stop() {
  state.stopping = true;
}

function status() {
  return {
    configured: isConfigured(),
    running: state.running,
    username: state.me?.username || null,
    started_at: state.startedAt,
    last_poll_at: state.lastPollAt,
    last_error: state.lastError,
    poll_failures: state.pollFailures,
    pending_batches: pendingImports.size,
  };
}

// Used by the digest scheduler and by event notifications from the API
async function broadcast(db, text, { kind = 'digest', respectDigestFlag = false } = {}) {
  const col = respectDigestFlag ? 'digest_enabled' : 'alerts_enabled';
  const chats = (await db.query(
    `SELECT chat_id, user_id FROM telegram_links WHERE active = 1 AND ${col} = 1`
  )).rows;
  let sent = 0;
  for (const c of chats) {
    try {
      await sendMessage(c.chat_id, text);
      await logActivity(db, { chatId: c.chat_id, userId: c.user_id, direction: 'out', kind, summary: text.slice(0, 120) });
      sent++;
    } catch (err) {
      console.error(`[telegram] broadcast to ${c.chat_id} failed: ${err.message}`);
    }
  }
  return sent;
}

module.exports = { start, stop, status, isConfigured, sendMessage, broadcast, parseExpenseMessage };
