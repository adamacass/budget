// Telegram bot — runs inside the app container, talks to Telegram by long
// polling. Polling (rather than webhooks) is what makes this work on a home
// desktop: Telegram never needs to reach you, so there is no public URL, no
// port forwarding and no tunnel involved.
//
// Nothing happens for a chat until it is linked to an app user with a one-time
// code generated in the admin UI. Unlinked chats get a single instruction and
// are otherwise ignored.

const { askBudget } = require('./ask');
const askActions = require('./ask-actions');
const screenshots = require('./screenshots');
const digestCard = require('./digest-card');

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

// Recent questions and answers per chat, so follow-ups like "and last month?"
// make sense. Kept in memory only: a restart starts every chat fresh.
const conversations = new Map();
const CONVERSATION_TTL_MS = 30 * 60 * 1000;
const CONVERSATION_TURNS = 6;

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

// The buttons that sit under the message box in every linked chat. Tapping one
// sends its label as a message, which handleMessage maps to the command.
const BUTTONS = {
  '📊 Daily update': '/digest',
  '🧾 This week': '/week',
  '💰 Offset': '/offset',
  '❓ Help': '/help',
};
const KEYBOARD = {
  keyboard: [
    [{ text: '📊 Daily update' }, { text: '🧾 This week' }],
    [{ text: '💰 Offset' }, { text: '❓ Help' }],
  ],
  is_persistent: true,
  resize_keyboard: true,
};

// Upload a PNG (a Buffer) as a photo. Multipart, since JSON can't carry the file.
async function sendPhoto(chatId, png, { caption, disableNotification = false, replyMarkup } = {}) {
  const t = token();
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([png], { type: 'image/png' }), 'update.png');
  if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
  form.append('disable_notification', String(!!disableNotification));
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(`${API}/bot${t}/sendPhoto`, { method: 'POST', body: form, signal: controller.signal });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(json.description || `Telegram sendPhoto failed (${res.status})`);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

// Telegram caps photo captions at 1024 characters (after HTML is parsed)
const CAPTION_LIMIT = 1000;

async function buildUpdate(db) {
  const { getMortgageConfig, nonSpending } = deps;
  const mortgageConfig = await getMortgageConfig(db);
  const data = await digest.buildDigestData(db, { mortgageConfig, nonSpending });
  return {
    data,
    caption: digest.buildDigestCaption(data),
    fallback: await digest.buildDailyDigest(db, { mortgageConfig, nonSpending, data }),
  };
}

// One chat's daily update: the card greeting them by name, with who-spent-what
// as the caption, sent with sound so it shows as a notification. The buttons
// ride along so they're always under the message box. If the card can't be
// drawn, the full text update goes instead.
async function sendUpdate(chatId, name, update) {
  let png = null;
  try { png = digestCard.renderCardPng(update.data, { name }); } catch (err) {
    console.error(`[digest] card failed, sending text only: ${err.message}`);
  }
  if (!png) return sendMessage(chatId, update.fallback, { reply_markup: KEYBOARD });
  if (update.caption.replace(/<[^>]+>/g, '').length <= CAPTION_LIMIT) {
    return sendPhoto(chatId, png, { caption: update.caption, replyMarkup: KEYBOARD });
  }
  await sendPhoto(chatId, png, { replyMarkup: KEYBOARD });
  return sendMessage(chatId, update.caption, { disable_notification: true });
}

async function broadcastDigest(db) {
  const chats = (await db.query(
    `SELECT l.chat_id, l.user_id, u.display_name FROM telegram_links l
     JOIN users u ON u.id = l.user_id WHERE l.active = 1 AND l.digest_enabled = 1`
  )).rows;
  if (!chats.length) return 0;
  const update = await buildUpdate(db);
  let sent = 0;
  for (const c of chats) {
    try {
      await sendUpdate(c.chat_id, c.display_name, update);
      await logActivity(db, { chatId: c.chat_id, userId: c.user_id, direction: 'out', kind: 'digest', summary: update.caption.slice(0, 120) });
      sent++;
    } catch (err) {
      console.error(`[telegram] digest to ${c.chat_id} failed: ${err.message}`);
    }
  }
  return sent;
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

// "how much did we spend on 2 dinners?" contains an amount but is a question,
// so questions are recognised before expenses are parsed
const QUESTION_START = /^(what|what's|whats|how|why|when|where|which|who|can|could|should|would|will|is|are|am|do|does|did|was|were|have|has|tell|show|explain|compare|summari[sz]e|list|give|any|ask)\b/i;
// ...and so are instructions: "move 500 to new car" is a request, not a $500 expense
const INSTRUCTION_START = /^(please\s+)?(move|allocate|reallocate|transfer|put|shift|take|change|set|update|edit|fix|correct|delete|remove|undo|recategori[sz]e|categori[sz]e|rename|split|create|make|start|top up|withdraw|deposit|record|mark)\b/i;
function looksLikeQuestion(text) {
  const t = String(text || '').trim();
  return t.endsWith('?') || QUESTION_START.test(t) || INSTRUCTION_START.test(t);
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
  '<b>Send screenshots</b> of your banking app (several at once is fine)',
  'and I\'ll read and categorise the transactions, then ask before saving.',
  'Reply to fix anything first, e.g. <code>3 groceries</code> or <code>remove 5</code>.',
  'An offset account screenshot updates the offset balance and its deposits.',
  '',
  '<b>Ask a question</b> about the budget:',
  '   <code>how much did we spend on takeaway this month?</code>',
  '   <code>are we on track for the holiday bucket?</code>',
  '',
  '<b>Ask for a change</b> and I\'ll set it up for you to approve:',
  '   <code>put the spare 8k in emergency, the rest in new car</code>',
  '   <code>the $45 Coles on Tuesday was mine, and it\'s groceries</code>',
  'Nothing changes until you tap <b>Apply</b>.',
  '',
  '<b>Buttons</b> under the message box: 📊 daily update, 🧾 this week, 💰 offset, ❓ help.',
  '',
  '<b>Commands</b>',
  '/offset — balance, buckets, payoff date',
  '/today — today\'s spending',
  '/week — last 7 days, by person and category',
  '/month — last 30 days',
  '/digest — the full daily update now',
  '/withdraw 500 new tyres — record money out of the offset',
  '/deposit 500 refund — record money in',
  '/undo — remove the last thing I added',
  '/mute /unmute — turn the daily digest off and on',
  '/new — start a fresh conversation (forget earlier questions)',
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
      return sendMessage(chatId, HELP, { reply_markup: KEYBOARD });

    case '/offset': {
      const mc = await getMortgageConfig(db);
      return sendMessage(chatId, await digest.buildOffsetSummary(db, { mortgageConfig: mc }));
    }

    case '/today':
      return sendMessage(chatId, await digest.buildSpendSummary(db, 1, { nonSpending }));
    case '/week':
      return sendMessage(chatId, await digest.buildWeekByPerson(db, { nonSpending }));
    case '/month':
      return sendMessage(chatId, await digest.buildSpendSummary(db, 30, { nonSpending }));

    case '/digest':
      return sendUpdate(chatId, link.display_name, await buildUpdate(db));

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
      await sendMessage(chatId,
        `${isDeposit ? '⬆️ Deposit' : '⬇️ Withdrawal'} of <b>${digest.fmt2(parsed.amount)}</b> recorded.\n` +
        `Offset is now <b>${digest.fmt(result.balance)}</b>.`);
      const why = parsed.description === 'Expense' ? '' : ` — ${parsed.description.replace(/[<>&]/g, '')}`;
      return notifyOthers(db, chatId,
        `${isDeposit ? '⬆️' : '⬇️'} <b>${link.display_name}</b> ${isDeposit ? 'put' : 'took'} <b>${digest.fmt2(parsed.amount)}</b> ` +
        `${isDeposit ? 'into' : 'out of'} the offset${why}. Offset now <b>${digest.fmt(result.balance)}</b>.`);
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

    case '/new':
      conversations.delete(String(chatId));
      return sendMessage(chatId, 'Fresh start. Ask away.');

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

  return sendMessage(chatId, `✅ Linked to <b>${row.display_name}</b>.\n\n${HELP}`, { reply_markup: KEYBOARD });
}

// Save / Discard on a screenshot batch (the batch logic lives in screenshots.js)
async function handleCallback(db, cb) {
  const chatId = cb.message?.chat?.id;
  const link = await getLink(db, chatId);
  if (!link) return;
  const [action, id] = String(cb.data || '').split(':');
  if (action === 'import' || action === 'discard') {
    return screenshots.onCallback(db, link, cb, action, id);
  }
  if (action === 'apply' || action === 'cancel') {
    return onChangesCallback(db, link, cb, action, id);
  }
}

async function handleQuestion(db, link, chatId, text) {
  const key = String(chatId);
  const convo = conversations.get(key);
  const history = convo && Date.now() - convo.at < CONVERSATION_TTL_MS ? convo.turns : [];

  // Telegram clears "typing…" after ~5 seconds, and an answer can take longer
  const typing = () => callTelegram('sendChatAction', { chat_id: chatId, action: 'typing' }, { timeoutMs: 10000 }).catch(() => {});
  typing();
  const typingTimer = setInterval(typing, 4500);

  let answer;
  try {
    const mc = await deps.getMortgageConfig(db);
    const contextText = (await digest.buildOffsetSummary(db, { mortgageConfig: mc })).replace(/<[^>]+>/g, '');
    answer = await deps.askBudget({
      pool: db,
      question: text,
      history,
      askerName: link.display_name,
      contextText,
    });
  } finally {
    clearInterval(typingTimer);
  }

  if (answer.plain) {
    const turns = [...history, { role: 'user', content: text }, { role: 'assistant', content: answer.plain }];
    conversations.set(key, { turns: turns.slice(-CONVERSATION_TURNS * 2), at: Date.now() });
  }
  await logActivity(db, { chatId, userId: link.user_id, direction: 'in', kind: 'question', summary: text.slice(0, 200) });
  await sendMessage(chatId, answer.text);
  if (answer.proposals?.length) return proposeChanges(chatId, link, answer.proposals);
}

// --- changes Claude proposed, waiting for Apply ------------------------------

const pendingChanges = new Map();     // chatId -> { id, proposals, userId, at }
const CHANGES_TTL_MS = 30 * 60 * 1000;

async function proposeChanges(chatId, link, proposals) {
  const id = `${Date.now().toString(36)}`;
  pendingChanges.set(String(chatId), { id, proposals, userId: link.user_id, at: Date.now() });
  const lines = [`<b>Apply ${proposals.length === 1 ? 'this change' : `these ${proposals.length} changes`}?</b>`, ''];
  proposals.forEach((p, i) => lines.push(`${i + 1}. ${p.summary}`));
  return sendMessage(chatId, lines.join('\n'), {
    reply_markup: { inline_keyboard: [[
      { text: '✅ Apply', callback_data: `apply:${id}` },
      { text: '❌ Cancel', callback_data: `cancel:${id}` },
    ]] },
  });
}

async function onChangesCallback(db, link, cb, action, id) {
  const chatId = String(cb.message?.chat?.id);
  const messageId = cb.message?.message_id;
  const pending = pendingChanges.get(chatId);
  const ack = (text) => callTelegram('answerCallbackQuery', { callback_query_id: cb.id, text }, { timeoutMs: 15000 }).catch(() => {});
  const replace = (text) => callTelegram('editMessageText', {
    chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
  }, { timeoutMs: 15000 }).catch(() => sendMessage(chatId, text));

  if (!pending || pending.id !== id || Date.now() - pending.at > CHANGES_TTL_MS) {
    pendingChanges.delete(chatId);
    await ack('That has expired. Ask again.');
    return replace('<i>Expired, nothing changed. Ask again if you still want it.</i>');
  }
  pendingChanges.delete(chatId);
  const list = pending.proposals.map((p, i) => `${i + 1}. ${p.summary}`).join('\n');

  if (action === 'cancel') {
    await ack('Cancelled');
    return replace(`❌ <b>Cancelled</b>, nothing changed.\n\n<s>${list.replace(/<\/?[bi]>/g, '')}</s>`);
  }

  try {
    await deps.applyChanges(db, pending.proposals, link.user_id);
  } catch (err) {
    console.error(`[ask] apply failed: ${err.message}`);
    await ack('Not applied');
    return replace(`⚠️ <b>Not applied</b>: ${err.message.replace(/[<>&]/g, '')}\n\nNothing changed. Ask again and I'll redo it with the current numbers.`);
  }
  await ack('Done');
  await logActivity(db, { chatId, userId: link.user_id, direction: 'in', kind: 'claude_changes', summary: list.replace(/<[^>]+>/g, '').slice(0, 500) });
  await replace(`✅ <b>Done</b>\n\n${list}`);

  // Remember it in the conversation, so "undo that" or a follow-up makes sense
  const convo = conversations.get(chatId);
  if (convo) convo.turns.push({ role: 'user', content: '(Tapped Apply.)' }, { role: 'assistant', content: `Applied: ${list.replace(/<[^>]+>/g, '')}` });

  return notifyOthers(db, chatId, `✏️ <b>${link.display_name}</b> made ${pending.proposals.length === 1 ? 'a change' : `${pending.proposals.length} changes`} via the bot:\n\n${list}`);
}

// Tell everyone except the person who did something, so the household stays in
// sync. Goes to each of the other people's linked chats (with alerts on).
async function notifyHousehold(db, actorUserId, text) {
  const others = (await db.query(
    'SELECT chat_id, user_id FROM telegram_links WHERE active = 1 AND alerts_enabled = 1 AND user_id <> $1',
    [actorUserId]
  )).rows;
  for (const o of others) {
    try {
      await sendMessage(o.chat_id, text);
      await logActivity(db, { chatId: o.chat_id, userId: o.user_id, direction: 'out', kind: 'household_alert', summary: text.slice(0, 200) });
    } catch (err) {
      console.error(`[telegram] alert to ${o.chat_id} failed: ${err.message}`);
    }
  }
}

// The same, starting from the chat the change came from
async function notifyOthers(db, originChatId, text) {
  const origin = (await db.query('SELECT user_id FROM telegram_links WHERE chat_id = $1', [String(originChatId)])).rows[0];
  if (!origin) return;
  return notifyHousehold(db, origin.user_id, text);
}

async function handleMessage(db, msg) {
  const chatId = msg.chat?.id;
  if (!chatId) return;
  const text = msg.text || msg.caption || '';

  const link = await getLink(db, chatId);
  if (!link) return handleLinking(db, chatId, text, msg.from);

  await db.query('UPDATE telegram_links SET last_seen_at = NOW() WHERE chat_id = $1', [String(chatId)]);

  if (screenshots.imageOf(msg)) {
    return screenshots.onPhoto(db, link, msg);
  }

  // A tap on one of the buttons under the message box
  const button = BUTTONS[text.trim()];
  if (button || text.startsWith('/')) {
    const command = button || text;
    await logActivity(db, { chatId, userId: link.user_id, direction: 'in', kind: 'command', summary: command.slice(0, 100) });
    return handleCommand(db, link, chatId, command);
  }

  // While screenshots are waiting for Save, a reply may be fixes to that list
  if (screenshots.hasPending(chatId) && await screenshots.onText(db, link, msg, text)) return;

  // A question, or anything without an amount, goes to Claude; the rest is an expense
  const parsed = looksLikeQuestion(text) ? null : parseExpenseMessage(text);
  if (!parsed) {
    if (!text.trim()) return;
    return handleQuestion(db, link, chatId, text);
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

      // Expire stale screenshot batches and conversations
      const now = Date.now();
      screenshots.sweep();
      for (const [k, v] of conversations) {
        if (now - v.at > CONVERSATION_TTL_MS) conversations.delete(k);
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
  deps = { askBudget, applyChanges: askActions.apply, ...dependencies };
  digest = dependencies.digest;
  screenshots.init({
    callTelegram, sendMessage, logActivity, notifyOthers,
    getDeps: () => deps, apiBase: API, token,
  });
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

  // The "/" menu beside the message box
  await callTelegram('setMyCommands', {
    commands: [
      { command: 'digest', description: 'Daily update with the card' },
      { command: 'week', description: 'This week by person and category' },
      { command: 'offset', description: 'Offset balance, buckets, payoff date' },
      { command: 'today', description: "Today's spending" },
      { command: 'month', description: 'Last 30 days' },
      { command: 'undo', description: 'Remove the last thing I added' },
      { command: 'new', description: 'Forget earlier questions' },
      { command: 'help', description: 'Everything I can do' },
    ],
  }, { timeoutMs: 15000 }).catch(err => console.error(`[telegram] setMyCommands failed: ${err.message}`));

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
    pending_batches: screenshots._batches.size,
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

module.exports = { start, stop, status, isConfigured, sendMessage, sendPhoto, broadcast, broadcastDigest, notifyHousehold, parseExpenseMessage, looksLikeQuestion };
