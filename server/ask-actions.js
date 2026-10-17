// Changes Claude can make from the Telegram chat, with the user's say-so.
//
// Claude never writes to the database directly. It calls these tools to
// *propose* changes; each proposal is checked against the current data and
// described in plain words, and nothing happens until the person taps Apply.
// Apply re-checks everything inside one transaction, so a batch lands whole or
// not at all, then tells the other person what changed.

const { fmt2 } = require('./digest');

const nullable = (type) => ({ type: [type, 'null'] });

const TOOLS = [
  {
    name: 'move_bucket_money',
    description: 'Move money between the unallocated part of the offset and an offset bucket (savings goal). Positive amount moves money into the bucket from unallocated; negative moves it back out to unallocated. To move between two buckets, call it twice (take from one, add to the other). Buckets can never hold more in total than the offset balance.',
    input_schema: {
      type: 'object',
      properties: {
        goal_id: { type: 'integer', description: 'savings_goals.id' },
        amount: { type: 'number', description: 'Dollars; positive into the bucket, negative out of it' },
      },
      required: ['goal_id', 'amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_bucket',
    description: "Change a bucket's name, target amount or target date. Pass null for anything that stays the same.",
    input_schema: {
      type: 'object',
      properties: {
        goal_id: { type: 'integer' },
        name: nullable('string'),
        target_amount: nullable('number'),
        target_date: { ...nullable('string'), description: 'YYYY-MM-DD or null' },
      },
      required: ['goal_id', 'name', 'target_amount', 'target_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_bucket',
    description: 'Start a new offset bucket (savings goal) with a target. It starts empty; use move_bucket_money to put money in.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' }, target_amount: { type: 'number' } },
      required: ['name', 'target_amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_expense',
    description: 'Log an expense (actual spending). person is the username it belongs to, normally the person asking.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number' },
        description: { type: 'string' },
        category: { type: 'string', description: 'One of the categories already used in expenses' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        person: { type: 'string', description: 'users.username' },
      },
      required: ['amount', 'description', 'category', 'date', 'person'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_expense',
    description: 'Correct an existing expense (find its id with run_sql first). Pass null for fields that stay the same.',
    input_schema: {
      type: 'object',
      properties: {
        expense_id: { type: 'integer' },
        category: nullable('string'),
        amount: nullable('number'),
        description: nullable('string'),
        date: { ...nullable('string'), description: 'YYYY-MM-DD or null' },
      },
      required: ['expense_id', 'category', 'amount', 'description', 'date'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_expense',
    description: 'Delete an expense that is wrong or a duplicate (find its id with run_sql first).',
    input_schema: {
      type: 'object',
      properties: { expense_id: { type: 'integer' } },
      required: ['expense_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'offset_movement',
    description: 'Record money going into (deposit) or out of (withdrawal) the offset account. Changes the offset balance by that amount.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['deposit', 'withdrawal'] },
        amount: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['direction', 'amount', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_offset_balance',
    description: "Set the offset balance to an exact figure, e.g. to match the bank. Doesn't touch the buckets.",
    input_schema: {
      type: 'object',
      properties: { balance: { type: 'number' }, note: { type: 'string' } },
      required: ['balance', 'note'],
      additionalProperties: false,
    },
  },
].map(t => ({ ...t, strict: true }));

const NAMES = new Set(TOOLS.map(t => t.name));

// --- reading current state ----------------------------------------------------

async function snapshot(db) {
  const bal = (await db.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
  const goals = (await db.query('SELECT id, name, current_amount, target_amount FROM savings_goals WHERE active = 1')).rows
    .map(g => ({ ...g, current_amount: parseFloat(g.current_amount) || 0, target_amount: parseFloat(g.target_amount) || 0 }));
  const users = (await db.query('SELECT id, username, display_name FROM users')).rows;
  const categories = (await db.query(
    "SELECT category FROM category_budgets UNION SELECT DISTINCT category FROM expenses WHERE entry_type = 'actual'"
  )).rows.map(r => r.category);
  return { balance: bal ? parseFloat(bal.balance) : 0, goals, users, categories };
}

const round2 = n => Math.round(n * 100) / 100;
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00'));

// Check one proposal against `state` (which earlier proposals in the same
// batch have already been applied to) and describe it. Returns
// { ok: true, summary } or { ok: false, error }, and updates `state`.
async function check(db, state, name, input) {
  const goal = id => state.goals.find(g => g.id === id);
  const allocated = () => state.goals.reduce((s, g) => s + g.current_amount, 0);

  switch (name) {
    case 'move_bucket_money': {
      const g = goal(input.goal_id);
      if (!g) return { ok: false, error: `No active bucket with id ${input.goal_id}.` };
      const amt = round2(input.amount);
      if (!amt) return { ok: false, error: 'Amount must not be zero.' };
      const next = round2(g.current_amount + amt);
      if (next < 0) return { ok: false, error: `${g.name} only has ${fmt2(g.current_amount)}; can't take ${fmt2(-amt)} out.` };
      const unallocated = round2(state.balance - allocated());
      if (amt > unallocated + 0.01) return { ok: false, error: `Only ${fmt2(unallocated)} is unallocated right now (after the earlier changes in this request); can't add ${fmt2(amt)} to ${g.name}.` };
      const before = g.current_amount;
      g.current_amount = next;
      return { ok: true, summary: `${amt > 0 ? 'Move' : 'Take'} <b>${fmt2(Math.abs(amt))}</b> ${amt > 0 ? 'into' : 'out of'} <b>${esc(g.name)}</b>: ${fmt2(before)} → ${fmt2(next)}${g.target_amount ? ` of ${fmt2(g.target_amount)}` : ''}` };
    }
    case 'update_bucket': {
      const g = goal(input.goal_id);
      if (!g) return { ok: false, error: `No active bucket with id ${input.goal_id}.` };
      const bits = [];
      if (input.name) bits.push(`rename to <b>${esc(input.name)}</b>`);
      if (input.target_amount != null) {
        if (input.target_amount <= 0) return { ok: false, error: 'Target must be above zero.' };
        bits.push(`target ${fmt2(g.target_amount)} → <b>${fmt2(input.target_amount)}</b>`);
      }
      if (input.target_date) {
        if (!validDate(input.target_date)) return { ok: false, error: 'target_date must be YYYY-MM-DD.' };
        bits.push(`target date <b>${esc(input.target_date)}</b>`);
      }
      if (!bits.length) return { ok: false, error: 'Nothing to change.' };
      return { ok: true, summary: `<b>${esc(g.name)}</b>: ${bits.join(', ')}` };
    }
    case 'create_bucket': {
      if (!String(input.name || '').trim()) return { ok: false, error: 'A bucket needs a name.' };
      if (!(input.target_amount > 0)) return { ok: false, error: 'Target must be above zero.' };
      return { ok: true, summary: `New bucket <b>${esc(input.name.trim())}</b>, target ${fmt2(input.target_amount)}` };
    }
    case 'add_expense': {
      if (!(input.amount > 0)) return { ok: false, error: 'Amount must be above zero.' };
      if (!validDate(input.date)) return { ok: false, error: 'date must be YYYY-MM-DD.' };
      if (!state.categories.includes(input.category)) return { ok: false, error: `Unknown category "${input.category}". Use one of: ${state.categories.join(', ')}.` };
      const u = state.users.find(x => x.username === input.person);
      if (!u) return { ok: false, error: `No user "${input.person}". Users: ${state.users.map(x => x.username).join(', ')}.` };
      return { ok: true, summary: `Add expense <b>${fmt2(input.amount)}</b> ${esc(input.description)} <i>${esc(input.category)}</i>, ${esc(input.date)}, ${esc(u.display_name)}` };
    }
    case 'update_expense':
    case 'delete_expense': {
      const e = (await db.query('SELECT e.*, u.display_name FROM expenses e JOIN users u ON u.id = e.user_id WHERE e.id = $1', [input.expense_id])).rows[0];
      if (!e) return { ok: false, error: `No expense with id ${input.expense_id}.` };
      const label = `${fmt2(e.amount)} ${esc(e.description || '')} (${esc(e.expense_date)}, ${esc(e.display_name)})`;
      if (name === 'delete_expense') return { ok: true, summary: `Delete ${label}` };
      const bits = [];
      if (input.category) {
        if (!state.categories.includes(input.category)) return { ok: false, error: `Unknown category "${input.category}".` };
        bits.push(`category ${esc(e.category)} → <b>${esc(input.category)}</b>`);
      }
      if (input.amount != null) {
        if (!(input.amount > 0)) return { ok: false, error: 'Amount must be above zero.' };
        bits.push(`amount → <b>${fmt2(input.amount)}</b>`);
      }
      if (input.description) bits.push(`description → <b>${esc(input.description)}</b>`);
      if (input.date) {
        if (!validDate(input.date)) return { ok: false, error: 'date must be YYYY-MM-DD.' };
        bits.push(`date → <b>${esc(input.date)}</b>`);
      }
      if (!bits.length) return { ok: false, error: 'Nothing to change.' };
      return { ok: true, summary: `Change ${label}: ${bits.join(', ')}` };
    }
    case 'offset_movement': {
      if (!(input.amount > 0)) return { ok: false, error: 'Amount must be above zero.' };
      const before = state.balance;
      state.balance = round2(before + (input.direction === 'deposit' ? input.amount : -input.amount));
      if (state.balance < 0) return { ok: false, error: `The offset only has ${fmt2(before)}.` };
      return { ok: true, summary: `Offset ${input.direction} <b>${fmt2(input.amount)}</b> — ${esc(input.reason)}: ${fmt2(before)} → ${fmt2(state.balance)}` };
    }
    case 'set_offset_balance': {
      if (!(input.balance >= 0)) return { ok: false, error: 'Balance must be zero or more.' };
      const before = state.balance;
      state.balance = round2(input.balance);
      return { ok: true, summary: `Set the offset balance ${fmt2(before)} → <b>${fmt2(state.balance)}</b> (${esc(input.note)})` };
    }
  }
  return { ok: false, error: `Unknown action ${name}.` };
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- applying -----------------------------------------------------------------

// Re-check the whole batch against fresh data, then write it in one transaction
async function apply(db, actions, actorId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Lock the offset ledger so two Applies can't interleave
    await client.query("SELECT pg_advisory_xact_lock(hashtext('budget-offset'))");
    const state = await snapshot(client);
    for (const a of actions) {
      const c = await check(client, state, a.name, a.input);
      if (!c.ok) throw new Error(`Things changed since this was proposed: ${c.error}`);
    }

    const prevBalance = (await snapshot(client)).balance;
    let balanceNote = null;
    for (const { name, input } of actions) {
      switch (name) {
        case 'move_bucket_money':
          await client.query('UPDATE savings_goals SET current_amount = ROUND((current_amount + $1)::numeric, 2) WHERE id = $2', [input.amount, input.goal_id]);
          await client.query('INSERT INTO goal_contributions (goal_id, user_id, amount, notes) VALUES ($1, $2, $3, $4)',
            [input.goal_id, actorId, input.amount, 'Via Telegram']);
          break;
        case 'update_bucket':
          await client.query(
            'UPDATE savings_goals SET name = COALESCE($1, name), target_amount = COALESCE($2, target_amount), target_date = COALESCE($3, target_date) WHERE id = $4',
            [input.name || null, input.target_amount ?? null, input.target_date || null, input.goal_id]);
          break;
        case 'create_bucket':
          await client.query('INSERT INTO savings_goals (name, target_amount, current_amount, created_by) VALUES ($1, $2, 0, $3)',
            [input.name.trim(), input.target_amount, actorId]);
          break;
        case 'add_expense': {
          const u = state.users.find(x => x.username === input.person);
          await client.query(
            `INSERT INTO expenses (user_id, category, subcategory, description, amount, expense_date, entry_type)
             VALUES ($1, $2, 'telegram', $3, $4, $5, 'actual')`,
            [u.id, input.category, input.description, input.amount, input.date]);
          break;
        }
        case 'update_expense':
          await client.query(
            'UPDATE expenses SET category = COALESCE($1, category), amount = COALESCE($2, amount), description = COALESCE($3, description), expense_date = COALESCE($4, expense_date) WHERE id = $5',
            [input.category || null, input.amount ?? null, input.description || null, input.date || null, input.expense_id]);
          break;
        case 'delete_expense': {
          const e = (await client.query('SELECT * FROM expenses WHERE id = $1', [input.expense_id])).rows[0];
          // Same memory the app keeps, so a later import won't bring it back
          await client.query('INSERT INTO deleted_expenses (description, amount, expense_date, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
            [e.description, e.amount, e.expense_date, e.user_id]);
          await client.query('DELETE FROM expenses WHERE id = $1', [input.expense_id]);
          break;
        }
        case 'offset_movement': {
          const signed = input.direction === 'deposit' ? -input.amount : input.amount;
          await client.query(
            "INSERT INTO offset_withdrawals (user_id, amount, withdrawal_date, reason, category) VALUES ($1, $2, $3, $4, 'Other')",
            [actorId, signed, new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'Australia/Sydney' }), input.reason]);
          balanceNote = balanceNote || input.reason;
          break;
        }
        case 'set_offset_balance':
          balanceNote = input.note;
          break;
      }
    }
    // One balance row for the net effect of any offset changes
    if (state.balance !== prevBalance) {
      await client.query(
        "INSERT INTO account_balances (account_type, balance, updated_by, note, source) VALUES ('offset', $1, $2, $3, 'telegram')",
        [state.balance, actorId, balanceNote || 'Via Telegram']);
    }
    await client.query('COMMIT');
    return state;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { TOOLS, NAMES, snapshot, check, apply };
