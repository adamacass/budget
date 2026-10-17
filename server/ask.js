// Answers free-text questions about the budget, for the Telegram bot.
//
// Claude answers by querying the database itself with run_sql. Every query runs
// inside a read-only transaction as the budget_ai_ro role (set up in db.js),
// which can read the budget tables but not password hashes or Telegram data,
// and cannot write anything. If that role is missing, the query is refused
// rather than run with the app's full privileges.
//
// To change things (move money between buckets, fix an expense...) Claude
// calls the action tools in ask-actions.js. Those only *propose*: they come
// back to the bot as `proposals`, and nothing is written until the person
// taps Apply.

const Anthropic = require('@anthropic-ai/sdk');
const { AI_RO_ROLE } = require('./db');
const actions = require('./ask-actions');

const MODEL = 'claude-sonnet-5-5';
const MAX_TOOL_ROUNDS = 8;
const MAX_ROWS = 200;
const MAX_RESULT_CHARS = 20000;

let client = null;
function getClient() {
  if (!client && process.env.ANTHROPIC_API_KEY) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const SYSTEM_PROMPT = `You answer questions about a two-person household budget, over Telegram. The household runs an offset-centric model: all surplus cash goes into the mortgage offset account, and savings goals are virtual "buckets" earmarked inside the offset rather than separate accounts.

You can query the household's PostgreSQL database with the run_sql tool. Look things up rather than guessing, and run as many queries as you need. Each call takes one SELECT (or WITH ... SELECT) statement.

Schema (dates stored as TEXT 'YYYY-MM-DD' unless noted; amounts are AUD):
- users(id, username, display_name, role, pay_cycle, mortgage_contribution) - the two household members
- expenses(id, user_id, category, subcategory, description, amount, expense_date, entry_type, recurring, created_at) - spending. entry_type 'actual' is real spending; other values are estimates. Category 'Transfer' is money moving between accounts, not spending, so exclude it from spending totals. subcategory 'telegram' marks entries logged through this bot.
- income_entries(id, user_id, amount, net_amount, pay_date, pay_type, retention_amount, offset_transfer, mortgage_contribution, is_surplus, notes) - pay days. offset_transfer is what that pay put into the offset; retention_amount is what the person kept for spending.
- account_balances(id, account_type, balance, updated_at timestamptz, note, source) - balance snapshots. The current offset balance is the latest row with account_type = 'offset' by updated_at.
- offset_withdrawals(id, user_id, amount, withdrawal_date, reason, category, goal_id) - money taken out of the offset; a negative amount is a deposit back in.
- planned_withdrawals(id, user_id, label, amount, target_date, recurring, frequency_months, active) - future withdrawals used in projections.
- savings_goals(id, name, target_amount, current_amount, priority, target_date, is_joint, active, is_offset_bucket) - offset buckets.
- goal_contributions(id, goal_id, user_id, amount, contributed_at timestamptz, notes)
- fund_allocations(id, user_id, income_entry_id, target_account, amount, allocated_date, notes) - rows with notes LIKE 'Mortgage%' are mortgage repayments.
- category_budgets(category, monthly_amount) - the monthly budget per category.
- levers(name, value, lever_type, active) - settings such as 'Mortgage Rate' (percent), 'Mortgage Monthly', 'Mortgage Start Date', 'Mortgage Term Years', 'Budget Scale %'. value is TEXT; cast it.
- upcoming_expenses(description, estimated_amount, expected_date, category, resolved)
- retention_profiles, category_rules, weekly_checkins - supporting tables.

Answering:
- Keep replies short, as you would in a chat: a few lines, with the key figure first. Round to whole dollars unless cents matter.
- Write plain text. You may use <b>bold</b> and <i>italic</i>, and no other markup: no Markdown, no tables, no headings.
- "I", "me" and "my" refer to the person asking, who is named in the context. "We" and "us" mean the household.
- If the data can't answer the question, say what is missing instead of estimating silently.

Making changes:
- When asked to change something (move money between buckets, log, fix or delete an expense, record an offset deposit or withdrawal, set the offset balance, create or edit a bucket), look up what you need with run_sql (ids, current amounts, unallocated = offset balance minus the sum of active buckets' current_amount), then call the action tools.
- Actions are proposals: the person sees a list of them and taps Apply before anything happens. So never say a change is done. Say what you've set up, in a line or two; the bot shows the full list under your reply.
- Do exactly what was asked, with the amounts they gave. Bucket targets are guides, not limits: "put 8k in emergency" means 8,000 into Emergency even if that passes its target, and "the rest to new car" means whatever is left after that. If something looks like a mistake, still propose the literal request and mention the alternative in one line; they can tap Cancel.
- If an action comes back with an error, fix it and call it again, or explain why it can't be done.
- Only propose changes the person asked for.`;

const RUN_SQL_TOOL = {
  name: 'run_sql',
  description: 'Run one read-only SELECT query against the household budget database and get the rows back as JSON (at most 200 rows). Use aggregates (SUM, COUNT, GROUP BY) rather than pulling raw rows where you can.',
  input_schema: {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'A single SELECT or WITH ... SELECT statement.' },
    },
    required: ['sql'],
    additionalProperties: false,
  },
  strict: true,
};

async function runReadOnlySql(pool, sql) {
  const text = String(sql || '').trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(text)) {
    return { error: 'Only a single SELECT (or WITH ... SELECT) statement is allowed.' };
  }
  if (text.includes(';')) {
    return { error: 'Only one statement per call.' };
  }

  const conn = await pool.connect();
  try {
    await conn.query('BEGIN READ ONLY');
    try {
      await conn.query(`SET LOCAL ROLE ${AI_RO_ROLE}`);
    } catch (e) {
      // Fail closed: never run model-written SQL with the app's own privileges
      return { error: 'Read-only access is not set up on this database, so questions are disabled.' };
    }
    await conn.query("SET LOCAL statement_timeout = '5s'");
    // Extended protocol: the server rejects multiple statements in one call
    const res = await conn.query({ text, queryMode: 'extended' });
    const rows = res.rows.slice(0, MAX_ROWS);
    let json = JSON.stringify({ row_count: res.rowCount, rows, truncated: res.rows.length > MAX_ROWS });
    if (json.length > MAX_RESULT_CHARS) {
      json = json.slice(0, MAX_RESULT_CHARS) + '... [cut off - aggregate or add a LIMIT]';
    }
    return { json };
  } catch (e) {
    return { error: e.message };
  } finally {
    await conn.query('ROLLBACK').catch(() => {});
    // Destroy rather than return to the pool, so no session state the query
    // might have set survives into the app's own queries
    conn.release(true);
  }
}

// Claude's text, made safe for Telegram's HTML parse mode: escape everything,
// then let <b> and <i> back through and turn stray **Markdown bold** into <b>.
function toTelegramHtml(text) {
  let s = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/&lt;(\/?)(b|i)&gt;/g, '<$1$2>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  // Telegram rejects the whole message if a tag is unbalanced
  for (const tag of ['b', 'i']) {
    const open = (s.match(new RegExp(`<${tag}>`, 'g')) || []).length;
    const close = (s.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    if (open !== close) s = s.replace(new RegExp(`</?${tag}>`, 'g'), '');
  }
  return s.trim();
}

function sydneyToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'Australia/Sydney' });
}

function createMessage(anthropic, round, messages) {
  return anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // On a safety decline, the API retries on a fallback model it picks
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium' },
    system: SYSTEM_PROMPT,
    tools: [RUN_SQL_TOOL, ...actions.TOOLS],
    // The last round is for answering with what has been found so far
    tool_choice: round === MAX_TOOL_ROUNDS ? { type: 'none' } : { type: 'auto' },
    messages,
  });
}

// history: [{ role: 'user' | 'assistant', content: string }], oldest first
async function askBudget({ pool, question, history = [], askerName, contextText }) {
  const anthropic = getClient();
  if (!anthropic) {
    return { text: 'Questions need a Claude API key. Add ANTHROPIC_API_KEY to .env, then run docker compose up -d.' };
  }

  const users = (await pool.query('SELECT display_name FROM users ORDER BY id')).rows.map(r => r.display_name);
  const context = [
    `Today is ${sydneyToday()} (Australia/Sydney).`,
    `The person asking is ${askerName}. Household members: ${users.join(', ')}.`,
    contextText ? `Current position, for reference:\n${contextText}` : '',
  ].filter(Boolean).join('\n');

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: `<context>\n${context}\n</context>\n\n${question}` },
  ];

  // Changes Claude proposes, each checked against the data as the earlier
  // proposals in this request would leave it
  const proposals = [];
  let state = null;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let response;
    try {
      response = await createMessage(anthropic, round, messages);
    } catch (e) {
      console.error(`[ask] Claude request failed: ${e.message}`);
      if (e instanceof Anthropic.AuthenticationError) {
        return { text: 'The Claude API key was rejected. Check ANTHROPIC_API_KEY in .env, then run docker compose up -d.' };
      }
      if (e instanceof Anthropic.RateLimitError) {
        return { text: "Claude's rate limit was hit. Try again in a minute." };
      }
      if (e instanceof Anthropic.APIError && e.status === 400 && /credit|billing/i.test(e.message)) {
        return { text: 'The Claude account is out of credit. Top it up at console.anthropic.com.' };
      }
      return { text: "Couldn't reach Claude just now. Try again shortly." };
    }

    if (response.stop_reason === 'refusal') {
      return { text: "I can't help with that one." };
    }

    if (response.stop_reason !== 'tool_use') {
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return { text: toTelegramHtml(text) || (proposals.length ? 'Here’s what I’d change:' : "I couldn't come up with an answer to that."), plain: text, proposals };
    }

    // Echo the full content back (thinking blocks included) and answer every tool call
    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      if (actions.NAMES.has(block.name)) {
        state = state || await actions.snapshot(pool);
        const c = await actions.check(pool, state, block.name, block.input || {});
        if (c.ok) proposals.push({ name: block.name, input: block.input, summary: c.summary });
        results.push(c.ok
          ? { type: 'tool_result', tool_use_id: block.id, content: `Proposed (not applied until the person taps Apply): ${c.summary.replace(/<[^>]+>/g, '')}` }
          : { type: 'tool_result', tool_use_id: block.id, is_error: true, content: c.error });
        continue;
      }
      if (block.name !== 'run_sql' || typeof block.input?.sql !== 'string') {
        results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: 'Unknown tool or missing sql.' });
        continue;
      }
      const r = await runReadOnlySql(pool, block.input.sql);
      results.push(r.error
        ? { type: 'tool_result', tool_use_id: block.id, is_error: true, content: r.error }
        : { type: 'tool_result', tool_use_id: block.id, content: r.json });
    }
    messages.push({ role: 'user', content: results });
  }

  return { text: "That took more lookups than I'm allowed. Try a narrower question.", proposals: [] };
}

module.exports = { askBudget, runReadOnlySql, toTelegramHtml };
