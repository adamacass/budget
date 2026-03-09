require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const { getDb, autoCategorizeTxn, getCategoryRules } = require('./db');
const { generateToken, authMiddleware } = require('./auth');
const { getPayDayAdvice, getNightlySummary, getAccountSweepAdvice, extractTransactionsFromImage } = require('./claude');

const app = express();
const PORT = process.env.PORT || 4000;

// All data analysis starts from this date
const DATA_START_DATE = '2026-01-01';
function clampDate(date) { return date < DATA_START_DATE ? DATA_START_DATE : date; }

// Wrap async route handlers so unhandled rejections return 500 instead of crashing
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Serve static frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
}

// Initialize DB on startup
let dbReady = false;
getDb().then(() => { dbReady = true; console.log('DB pool ready'); }).catch(err => { console.error('DB init failed:', err); });

// ===================== VERSION =====================

const pkg = require('../package.json');
const SERVER_START_TIME = new Date().toISOString();

app.get('/api/version', (req, res) => {
  res.json({
    version: pkg.version,
    serverStartedAt: SERVER_START_TIME,
  });
});

// ===================== AUTH ROUTES =====================

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const db = await getDb();
  const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = generateToken(user);
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      gross_income: user.gross_income,
      super_rate: user.super_rate,
      hecs_repayment_rate: user.hecs_repayment_rate,
      pay_cycle: user.pay_cycle
    }
  });
}));

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const { username, password, display_name, gross_income, pay_cycle, super_rate, hecs_repayment_rate } = req.body;
  const db = await getDb();
  const existing = (await db.query('SELECT id FROM users WHERE username = $1', [username])).rows[0];
  if (existing) return res.status(400).json({ error: 'Username already taken' });

  const hash = bcrypt.hashSync(password, 10);
  const result = await db.query(
    'INSERT INTO users (username, display_name, password_hash, gross_income, super_rate, hecs_repayment_rate, pay_cycle) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
    [username, display_name, hash, gross_income || 0, super_rate || 0.115, hecs_repayment_rate || 0, pay_cycle || 'fortnightly']
  );

  const user = result.rows[0];
  const token = generateToken(user);
  res.json({ token, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, gross_income: user.gross_income, pay_cycle: user.pay_cycle } });
}));

app.put('/api/auth/profile', authMiddleware, asyncHandler(async (req, res) => {
  const { display_name, gross_income, super_rate, hecs_repayment_rate, pay_cycle } = req.body;
  const db = await getDb();
  await db.query(
    'UPDATE users SET display_name = COALESCE($1, display_name), gross_income = COALESCE($2, gross_income), super_rate = COALESCE($3, super_rate), hecs_repayment_rate = COALESCE($4, hecs_repayment_rate), pay_cycle = COALESCE($5, pay_cycle) WHERE id = $6',
    [display_name, gross_income, super_rate, hecs_repayment_rate, pay_cycle, req.user.id]
  );
  const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
  res.json({ id: user.id, username: user.username, display_name: user.display_name, role: user.role, gross_income: user.gross_income, super_rate: user.super_rate, hecs_repayment_rate: user.hecs_repayment_rate, pay_cycle: user.pay_cycle });
}));

app.put('/api/auth/password', authMiddleware, asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;
  const db = await getDb();
  const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
  res.json({ message: 'Password updated' });
}));

// ===================== EXPENSE ROUTES =====================

app.get('/api/expenses', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const { start, end, category, user_id } = req.query;
  let query = 'SELECT e.*, u.display_name as user_name FROM expenses e JOIN users u ON e.user_id = u.id WHERE 1=1';
  const params = [];
  let paramIdx = 1;

  if (start) { query += ` AND e.expense_date >= $${paramIdx++}`; params.push(start); }
  if (end) { query += ` AND e.expense_date <= $${paramIdx++}`; params.push(end); }
  if (category) { query += ` AND e.category = $${paramIdx++}`; params.push(category); }
  if (user_id) { query += ` AND e.user_id = $${paramIdx++}`; params.push(user_id); }

  query += ' ORDER BY e.expense_date DESC, e.created_at DESC';
  const { rows } = await db.query(query, params);
  res.json(rows);
}));

app.post('/api/expenses', authMiddleware, asyncHandler(async (req, res) => {
  const { category, subcategory, description, amount, expense_date, entry_type, is_range, range_low, range_high, recurring } = req.body;
  const db = await getDb();
  const result = await db.query(
    'INSERT INTO expenses (user_id, category, subcategory, description, amount, expense_date, entry_type, is_range, range_low, range_high, recurring) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
    [req.user.id, category, subcategory || null, description || null, amount, expense_date, entry_type || 'actual', is_range ? 1 : 0, range_low || null, range_high || null, recurring ? 1 : 0]
  );
  const expense = (await db.query('SELECT e.*, u.display_name as user_name FROM expenses e JOIN users u ON e.user_id = u.id WHERE e.id = $1', [result.rows[0].id])).rows[0];
  res.json(expense);
}));

app.post('/api/expenses/batch', authMiddleware, asyncHandler(async (req, res) => {
  const { expenses } = req.body;
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const e of expenses) {
      await client.query(
        'INSERT INTO expenses (user_id, category, subcategory, description, amount, expense_date, entry_type, is_range, range_low, range_high, recurring) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [req.user.id, e.category, e.subcategory || null, e.description || null, e.amount, e.expense_date, e.entry_type || 'actual', e.is_range ? 1 : 0, e.range_low || null, e.range_high || null, e.recurring ? 1 : 0]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ message: `${expenses.length} expenses added` });
}));

app.delete('/api/expenses/:id', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  // Record deletion for persistent memory (prevent re-import)
  const expense = (await db.query('SELECT * FROM expenses WHERE id = $1', [req.params.id])).rows[0];
  if (!expense) {
    return res.status(404).json({ error: 'Expense not found' });
  }
  await db.query(
    'INSERT INTO deleted_expenses (description, amount, expense_date, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    [expense.description, expense.amount, expense.expense_date, expense.user_id]
  );
  // Household app: any authenticated user can delete any expense
  await db.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
  res.json({ message: 'Deleted' });
}));

// Update expense (full inline editing — category, description, amount, date, subcategory, recurring)
app.put('/api/expenses/:id', authMiddleware, asyncHandler(async (req, res) => {
  const { category, description, amount, expense_date, subcategory, recurring, learn_category } = req.body;
  const db = await getDb();
  const updates = [];
  const params = [];
  let paramIdx = 1;
  if (category) { updates.push(`category = $${paramIdx++}`); params.push(category); }
  if (description !== undefined) { updates.push(`description = $${paramIdx++}`); params.push(description); }
  if (amount !== undefined) { updates.push(`amount = $${paramIdx++}`); params.push(amount); }
  if (expense_date !== undefined) { updates.push(`expense_date = $${paramIdx++}`); params.push(expense_date); }
  if (subcategory !== undefined) { updates.push(`subcategory = $${paramIdx++}`); params.push(subcategory); }
  if (recurring !== undefined) { updates.push(`recurring = $${paramIdx++}`); params.push(recurring ? 1 : 0); }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  await db.query(`UPDATE expenses SET ${updates.join(', ')} WHERE id = $${paramIdx}`, params);

  // Learn category rule: extract a supplier pattern from the description and save
  if (category && category !== 'Other') {
    const expense = (await db.query('SELECT description FROM expenses WHERE id = $1', [req.params.id])).rows[0];
    if (expense?.description) {
      const pattern = extractSupplierPattern(expense.description);
      if (pattern && pattern.length >= 3) {
        await db.query(
          'INSERT INTO category_rules (supplier_pattern, category, created_by) VALUES ($1, $2, $3) ON CONFLICT (supplier_pattern) DO UPDATE SET category = $2',
          [pattern, category, req.user.id]
        );
      }
    }
  }

  const expense = (await db.query('SELECT e.*, u.display_name as user_name FROM expenses e JOIN users u ON e.user_id = u.id WHERE e.id = $1', [req.params.id])).rows[0];
  res.json(expense);
}));

// Extract a normalized supplier pattern from a transaction description
function extractSupplierPattern(desc) {
  if (!desc) return null;
  // Remove common suffixes like locations, states, country codes
  let pattern = desc
    .replace(/\s+(NSW|VIC|QLD|SA|WA|TAS|NT|ACT|Aus|Eng|Deu|Irl|Ca|Ns)\s*$/gi, '')
    .replace(/\s+(Sydney|Melbourne|Brisbane|Perth|Adelaide|Mosman|Chatswood|Mascot|San Francisco)\s*/gi, ' ')
    .replace(/\s+\d+\s*$/, '')  // trailing numbers
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Take the first meaningful words (the supplier name)
  const words = pattern.split(/\s+/);
  // Use at most the first 3 meaningful words as the pattern
  const meaningful = words.slice(0, Math.min(3, words.length)).join(' ');
  return meaningful.length >= 3 ? meaningful.toLowerCase() : null;
}

// ===================== CATEGORY RULES (learned mappings) =====================

app.get('/api/category-rules', authMiddleware, asyncHandler(async (req, res) => {
  const rules = await getCategoryRules();
  res.json(rules);
}));

app.post('/api/category-rules', authMiddleware, asyncHandler(async (req, res) => {
  const { supplier_pattern, category } = req.body;
  if (!supplier_pattern || !category) return res.status(400).json({ error: 'supplier_pattern and category required' });
  const db = await getDb();
  await db.query(
    'INSERT INTO category_rules (supplier_pattern, category, created_by) VALUES ($1, $2, $3) ON CONFLICT (supplier_pattern) DO UPDATE SET category = $2',
    [supplier_pattern.toLowerCase(), category, req.user.id]
  );
  res.json({ message: 'Rule saved', supplier_pattern, category });
}));

app.delete('/api/category-rules/:id', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  await db.query('DELETE FROM category_rules WHERE id = $1', [req.params.id]);
  res.json({ message: 'Rule deleted' });
}));

// Check for potential duplicates before importing
app.post('/api/expenses/check-duplicates', authMiddleware, asyncHandler(async (req, res) => {
  const { transactions } = req.body;
  if (!transactions || !transactions.length) return res.json({ duplicates: [] });
  const db = await getDb();
  const results = [];
  for (const t of transactions) {
    // Exact match: same date, amount, description
    const exact = (await db.query(
      'SELECT e.id, e.description, e.amount, e.expense_date, e.category, u.display_name as user_name FROM expenses e JOIN users u ON e.user_id = u.id WHERE e.expense_date = $1 AND e.amount = $2',
      [t.expense_date, t.amount]
    )).rows;
    // Near match: same date, similar amount (within $1)
    const near = exact.length === 0 ? (await db.query(
      'SELECT e.id, e.description, e.amount, e.expense_date, e.category, u.display_name as user_name FROM expenses e JOIN users u ON e.user_id = u.id WHERE e.expense_date = $1 AND ABS(e.amount - $2) <= 1 AND ABS(e.amount - $2) > 0',
      [t.expense_date, t.amount]
    )).rows : [];
    // Previously deleted
    const deleted = (await db.query(
      'SELECT id FROM deleted_expenses WHERE description = $1 AND amount = $2 AND expense_date = $3',
      [t.description, t.amount, t.expense_date]
    )).rows;
    results.push({
      transaction: t,
      exact_matches: exact,
      near_matches: near,
      was_deleted: deleted.length > 0,
      is_duplicate: exact.length > 0 || deleted.length > 0
    });
  }
  res.json({ results });
}));

// Expense summary by period (week/month/year) with per-user breakdown
app.get('/api/expenses/summary', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const now = new Date();

  // Week start (Monday)
  const todayDay = now.getDay();
  const diffToMonday = todayDay === 0 ? 6 : todayDay - 1;
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - diffToMonday);
  weekStart.setHours(0, 0, 0, 0);
  const weekStartStr = clampDate(weekStart.toISOString().split('T')[0]);

  // Month start
  const monthStart = clampDate(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`);

  // Year start
  const yearStart = clampDate(`${now.getFullYear()}-01-01`);

  const users = (await db.query('SELECT id, display_name FROM users')).rows;

  async function getPeriodData(start, daysInPeriod) {
    const total = (await db.query('SELECT SUM(amount) as total, COUNT(*) as count FROM expenses WHERE expense_date >= $1', [start])).rows[0];
    const byUser = [];
    for (const u of users) {
      const row = (await db.query('SELECT SUM(amount) as total, COUNT(*) as count FROM expenses WHERE user_id = $1 AND expense_date >= $2', [u.id, start])).rows[0];
      byUser.push({ user_id: u.id, display_name: u.display_name, total: parseFloat(row.total) || 0, count: parseInt(row.count) });
    }
    const byCategory = (await db.query(
      'SELECT category, SUM(amount) as total, COUNT(*) as count FROM expenses WHERE expense_date >= $1 GROUP BY category ORDER BY total DESC', [start]
    )).rows;
    return {
      total: parseFloat(total.total) || 0,
      count: parseInt(total.count),
      daily_avg: daysInPeriod > 0 ? Math.round((parseFloat(total.total) || 0) / daysInPeriod) : 0,
      by_user: byUser,
      by_category: byCategory.map(c => ({ ...c, total: parseFloat(c.total), count: parseInt(c.count) }))
    };
  }

  const weekDays = Math.max(1, Math.ceil((now - weekStart) / 86400000));
  const monthDays = Math.max(1, now.getDate());
  const yearDays = Math.max(1, Math.ceil((now - new Date(now.getFullYear(), 0, 1)) / 86400000));

  res.json({
    week: await getPeriodData(weekStartStr, weekDays),
    month: await getPeriodData(monthStart, monthDays),
    year: await getPeriodData(yearStart, yearDays),
  });
}));

// ===================== INCOME ROUTES =====================

app.get('/api/income', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const { start, end } = req.query;
  let query = 'SELECT i.*, u.display_name as user_name FROM income_entries i JOIN users u ON i.user_id = u.id WHERE 1=1';
  const params = [];
  let paramIdx = 1;
  if (start) { query += ` AND i.pay_date >= $${paramIdx++}`; params.push(start); }
  if (end) { query += ` AND i.pay_date <= $${paramIdx++}`; params.push(end); }
  query += ' ORDER BY i.pay_date DESC';
  const entries = (await db.query(query, params)).rows;

  // Attach goal contributions to each entry
  const entryIds = entries.map(e => e.id);
  let goalContribs = [];
  if (entryIds.length > 0) {
    goalContribs = (await db.query(
      `SELECT gc.income_entry_id, gc.amount, sg.name as goal_name
       FROM goal_contributions gc
       JOIN savings_goals sg ON gc.goal_id = sg.id
       WHERE gc.income_entry_id = ANY($1)`,
      [entryIds]
    )).rows;
  }

  const enriched = entries.map(e => ({
    ...e,
    goal_contributions: goalContribs.filter(gc => gc.income_entry_id === e.id)
  }));

  res.json(enriched);
}));

app.post('/api/income', authMiddleware, asyncHandler(async (req, res) => {
  const { amount, net_amount, pay_date, pay_type, notes } = req.body;
  const db = await getDb();
  const result = await db.query(
    'INSERT INTO income_entries (user_id, amount, net_amount, pay_date, pay_type, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [req.user.id, amount, net_amount || null, pay_date, pay_type || 'regular', notes || null]
  );
  res.json(result.rows[0]);
}));

// ===================== FUND ALLOCATION ROUTES =====================

app.get('/api/allocations', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const { rows } = await db.query('SELECT f.*, u.display_name as user_name FROM fund_allocations f JOIN users u ON f.user_id = u.id ORDER BY f.allocated_date DESC');
  res.json(rows);
}));

app.post('/api/allocations', authMiddleware, asyncHandler(async (req, res) => {
  const { income_entry_id, allocations } = req.body;
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const a of allocations) {
      await client.query(
        'INSERT INTO fund_allocations (user_id, income_entry_id, target_account, amount, allocated_date, notes) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.user.id, income_entry_id || null, a.target_account, a.amount, a.allocated_date || new Date().toISOString().split('T')[0], a.notes || null]
      );
      // Update account balance
      const existing = (await client.query('SELECT * FROM account_balances WHERE account_type = $1 ORDER BY updated_at DESC LIMIT 1', [a.target_account])).rows[0];
      const newBalance = (existing ? existing.balance : 0) + a.amount;
      await client.query('INSERT INTO account_balances (account_type, balance, updated_by) VALUES ($1, $2, $3)', [a.target_account, newBalance, req.user.id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ message: 'Allocations saved' });
}));

// ===================== ACCOUNT BALANCES =====================

app.get('/api/balances', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const accounts = ['offset', 'savings', 'credit_card', 'investment'];
  const balances = {};
  for (const acct of accounts) {
    const row = (await db.query('SELECT balance FROM account_balances WHERE account_type = $1 ORDER BY updated_at DESC LIMIT 1', [acct])).rows[0];
    balances[acct] = row ? row.balance : 0;
  }
  res.json(balances);
}));

app.put('/api/balances/:account', authMiddleware, asyncHandler(async (req, res) => {
  const { balance } = req.body;
  const db = await getDb();
  await db.query('INSERT INTO account_balances (account_type, balance, updated_by) VALUES ($1, $2, $3)', [req.params.account, balance, req.user.id]);
  res.json({ account: req.params.account, balance });
}));

// ===================== SAVINGS GOALS =====================

app.get('/api/goals', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  res.json((await db.query('SELECT g.*, u.display_name as created_by_name FROM savings_goals g JOIN users u ON g.created_by = u.id WHERE g.active = 1 ORDER BY g.priority ASC')).rows);
}));

app.post('/api/goals', authMiddleware, asyncHandler(async (req, res) => {
  const { name, target_amount, current_amount, priority, target_date, is_joint } = req.body;
  const db = await getDb();
  const result = await db.query(
    'INSERT INTO savings_goals (name, target_amount, current_amount, priority, target_date, created_by, is_joint) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
    [name, target_amount, current_amount || 0, priority || 5, target_date || null, req.user.id, is_joint !== undefined ? (is_joint ? 1 : 0) : 1]
  );
  res.json(result.rows[0]);
}));

app.put('/api/goals/:id', authMiddleware, asyncHandler(async (req, res) => {
  const { name, target_amount, current_amount, priority, target_date, active } = req.body;
  const db = await getDb();
  await db.query(
    'UPDATE savings_goals SET name = COALESCE($1, name), target_amount = COALESCE($2, target_amount), current_amount = COALESCE($3, current_amount), priority = COALESCE($4, priority), target_date = COALESCE($5, target_date), active = COALESCE($6, active) WHERE id = $7',
    [name, target_amount, current_amount, priority, target_date, active, req.params.id]
  );
  const goal = (await db.query('SELECT * FROM savings_goals WHERE id = $1', [req.params.id])).rows[0];
  res.json(goal);
}));

app.delete('/api/goals/:id', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  await db.query('UPDATE savings_goals SET active = 0 WHERE id = $1', [req.params.id]);
  res.json({ message: 'Goal deactivated' });
}));

// Bulk redistribute offset among goals
app.post('/api/goals/redistribute', authMiddleware, asyncHandler(async (req, res) => {
  const { allocations } = req.body; // [{ goal_id, amount }]
  const db = await getDb();

  // Validate: total allocations must not exceed offset balance
  const offsetRow = (await db.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
  const offsetBal = offsetRow ? offsetRow.balance : 0;
  const totalAllocated = allocations.reduce((s, a) => s + (a.amount || 0), 0);

  if (totalAllocated > offsetBal + 0.01) {
    return res.status(400).json({ error: `Total allocations ($${totalAllocated.toFixed(2)}) exceed offset balance ($${offsetBal.toFixed(2)})` });
  }

  // Update each goal's current_amount
  for (const a of allocations) {
    await db.query('UPDATE savings_goals SET current_amount = $1 WHERE id = $2 AND active = 1', [Math.max(0, a.amount || 0), a.goal_id]);
  }

  // Record contributions for audit
  for (const a of allocations) {
    const goal = (await db.query('SELECT current_amount FROM savings_goals WHERE id = $1', [a.goal_id])).rows[0];
    if (goal) {
      await db.query(
        'INSERT INTO goal_contributions (goal_id, user_id, amount, notes) VALUES ($1, $2, $3, $4)',
        [a.goal_id, req.user.id, a.amount || 0, 'Redistribution']
      );
    }
  }

  const goals = (await db.query('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;
  res.json({ goals, offset_balance: offsetBal });
}));

// ===================== LEVERS =====================

app.get('/api/levers', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  res.json((await db.query('SELECT l.*, u.display_name as set_by_name FROM levers l JOIN users u ON l.set_by = u.id WHERE l.active = 1 ORDER BY l.id')).rows);
}));

app.post('/api/levers', authMiddleware, asyncHandler(async (req, res) => {
  const { name, description, lever_type, value } = req.body;
  const db = await getDb();
  const result = await db.query(
    'INSERT INTO levers (name, description, lever_type, value, set_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [name, description || null, lever_type || 'percentage', value, req.user.id]
  );
  res.json(result.rows[0]);
}));

app.put('/api/levers/:id', authMiddleware, asyncHandler(async (req, res) => {
  const { value, name, description } = req.body;
  const db = await getDb();
  await db.query(
    'UPDATE levers SET value = COALESCE($1, value), name = COALESCE($2, name), description = COALESCE($3, description), set_by = $4, updated_at = NOW() WHERE id = $5',
    [value, name, description, req.user.id, req.params.id]
  );
  const lever = (await db.query('SELECT * FROM levers WHERE id = $1', [req.params.id])).rows[0];
  res.json(lever);
}));

app.delete('/api/levers/:id', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  await db.query('UPDATE levers SET active = 0 WHERE id = $1', [req.params.id]);
  res.json({ message: 'Lever deactivated' });
}));

// ===================== UPCOMING EXPENSES =====================

app.get('/api/upcoming-expenses', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  res.json((await db.query('SELECT ue.*, u.display_name as user_name FROM upcoming_expenses ue JOIN users u ON ue.user_id = u.id WHERE ue.resolved = 0 ORDER BY ue.expected_date ASC')).rows);
}));

app.post('/api/upcoming-expenses', authMiddleware, asyncHandler(async (req, res) => {
  const { description, estimated_amount, expected_date, category, notes } = req.body;
  const db = await getDb();
  const result = await db.query(
    'INSERT INTO upcoming_expenses (user_id, description, estimated_amount, expected_date, category, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [req.user.id, description, estimated_amount, expected_date, category || null, notes || null]
  );
  res.json(result.rows[0]);
}));

app.put('/api/upcoming-expenses/:id', authMiddleware, asyncHandler(async (req, res) => {
  const { resolved } = req.body;
  const db = await getDb();
  await db.query('UPDATE upcoming_expenses SET resolved = $1 WHERE id = $2', [resolved ? 1 : 0, req.params.id]);
  res.json({ message: 'Updated' });
}));

// ===================== RETENTION PROFILES =====================

app.get('/api/retention/:userId', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const userId = parseInt(req.params.userId);
  const user = (await db.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  let profile = (await db.query('SELECT * FROM retention_profiles WHERE user_id = $1', [userId])).rows[0];
  if (!profile) {
    profile = { retention_method: 'auto', fixed_amount: 0, lookback_weeks: 8, buffer_percent: 10, expense_source: 'all' };
  }

  if (profile.retention_method === 'fixed' && profile.fixed_amount > 0) {
    return res.json({
      user_id: userId,
      retention_method: 'fixed',
      calculated_retention: profile.fixed_amount,
      avg_per_period: profile.fixed_amount,
      buffer_amount: 0,
      upcoming_extra: 0,
      lookback_weeks: profile.lookback_weeks,
      pay_period: user.pay_cycle,
      by_category: {},
      profile
    });
  }

  // Auto-calculate from expense history
  const lookbackDays = profile.lookback_weeks * 7;
  const lookbackStart = clampDate(new Date(Date.now() - lookbackDays * 86400000).toISOString().split('T')[0]);

  const expenses = (await db.query(
    'SELECT category, SUM(amount) as total FROM expenses WHERE user_id = $1 AND expense_date >= $2 GROUP BY category',
    [userId, lookbackStart]
  )).rows;

  const totalExpenses = expenses.reduce((s, e) => s + parseFloat(e.total), 0);
  const periodsPerYear = user.pay_cycle === 'weekly' ? 52 : user.pay_cycle === 'fortnightly' ? 26 : 12;
  const weeksPerPeriod = 52 / periodsPerYear;
  const periodsInLookback = (profile.lookback_weeks / weeksPerPeriod);
  const avgPerPeriod = periodsInLookback > 0 ? totalExpenses / periodsInLookback : 0;
  const bufferAmount = avgPerPeriod * (profile.buffer_percent / 100);

  // Factor in upcoming expenses within next pay period
  const nextPayDays = Math.ceil(weeksPerPeriod * 7);
  const nextPayDate = new Date(Date.now() + nextPayDays * 86400000).toISOString().split('T')[0];
  const upcomingRows = (await db.query(
    'SELECT SUM(estimated_amount) as total FROM upcoming_expenses WHERE user_id = $1 AND resolved = 0 AND expected_date <= $2',
    [userId, nextPayDate]
  )).rows[0];
  const upcomingExtra = parseFloat(upcomingRows?.total) || 0;

  const byCategory = {};
  expenses.forEach(e => { byCategory[e.category] = Math.round(parseFloat(e.total) / periodsInLookback); });

  const calculatedRetention = avgPerPeriod + bufferAmount + upcomingExtra;

  res.json({
    user_id: userId,
    retention_method: 'auto',
    calculated_retention: Math.round(calculatedRetention * 100) / 100,
    avg_per_period: Math.round(avgPerPeriod * 100) / 100,
    buffer_amount: Math.round(bufferAmount * 100) / 100,
    upcoming_extra: upcomingExtra,
    lookback_weeks: profile.lookback_weeks,
    expense_count: expenses.length,
    pay_period: user.pay_cycle,
    by_category: byCategory,
    profile
  });
}));

app.put('/api/retention/:userId', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const userId = parseInt(req.params.userId);
  const { retention_method, fixed_amount, lookback_weeks, buffer_percent, expense_source } = req.body;

  const existing = (await db.query('SELECT id FROM retention_profiles WHERE user_id = $1', [userId])).rows[0];
  if (existing) {
    await db.query(
      'UPDATE retention_profiles SET retention_method = COALESCE($1, retention_method), fixed_amount = COALESCE($2, fixed_amount), lookback_weeks = COALESCE($3, lookback_weeks), buffer_percent = COALESCE($4, buffer_percent), expense_source = COALESCE($5, expense_source), updated_at = NOW() WHERE user_id = $6',
      [retention_method, fixed_amount, lookback_weeks, buffer_percent, expense_source, userId]
    );
  } else {
    await db.query(
      'INSERT INTO retention_profiles (user_id, retention_method, fixed_amount, lookback_weeks, buffer_percent, expense_source) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, retention_method || 'auto', fixed_amount || 0, lookback_weeks || 8, buffer_percent || 10, expense_source || 'all']
    );
  }
  const profile = (await db.query('SELECT * FROM retention_profiles WHERE user_id = $1', [userId])).rows[0];
  res.json(profile);
}));

// ===================== PAYDAY COMPLETE (offset-centric) =====================

app.post('/api/payday/complete', authMiddleware, asyncHandler(async (req, res) => {
  const { net_amount, gross_amount, pay_date, pay_type, notes, retention_amount, offset_amount, goal_allocations } = req.body;
  const db = await getDb();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1. Record income entry
    const incomeResult = await client.query(
      'INSERT INTO income_entries (user_id, amount, net_amount, pay_date, pay_type, notes, retention_amount, offset_transfer) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [req.user.id, gross_amount || net_amount, net_amount, pay_date, pay_type || 'regular', notes || null, retention_amount, offset_amount]
    );
    const incomeEntry = incomeResult.rows[0];

    // 2. Record offset allocation
    if (offset_amount > 0) {
      await client.query(
        'INSERT INTO fund_allocations (user_id, income_entry_id, target_account, amount, allocated_date, notes) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.user.id, incomeEntry.id, 'offset', offset_amount, pay_date, 'Offset transfer (surplus after retention)']
      );

      // Update offset balance
      const existing = (await client.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
      const newBalance = (existing ? existing.balance : 0) + offset_amount;
      await client.query("INSERT INTO account_balances (account_type, balance, updated_by) VALUES ('offset', $1, $2)", [newBalance, req.user.id]);
    }

    // 3. Process goal allocations (virtual buckets within offset)
    if (goal_allocations && goal_allocations.length > 0) {
      for (const ga of goal_allocations) {
        if (ga.amount > 0) {
          await client.query(
            'INSERT INTO goal_contributions (goal_id, user_id, amount, income_entry_id, notes) VALUES ($1, $2, $3, $4, $5)',
            [ga.goal_id, req.user.id, ga.amount, incomeEntry.id, ga.notes || 'PayDay contribution']
          );
          await client.query(
            'UPDATE savings_goals SET current_amount = current_amount + $1 WHERE id = $2',
            [ga.amount, ga.goal_id]
          );
        }
      }
    }

    await client.query('COMMIT');

    // Fetch updated data
    const offsetRow = (await db.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
    const goals = (await db.query('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;

    res.json({
      income_entry: incomeEntry,
      offset_balance: offsetRow?.balance || 0,
      goals,
      message: `Pay recorded. $${offset_amount.toFixed(2)} sent to offset.`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ===================== GOAL CONTRIBUTIONS =====================

app.get('/api/goal-contributions/:goalId', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const { rows } = await db.query(
    'SELECT gc.*, u.display_name as user_name FROM goal_contributions gc JOIN users u ON gc.user_id = u.id WHERE gc.goal_id = $1 ORDER BY gc.contributed_at DESC',
    [req.params.goalId]
  );
  res.json(rows);
}));

// ===================== PAYDAY EVENTS (for chart overlays) =====================

app.get('/api/payday-events', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const { days } = req.query;
  const numDays = Math.min(Math.max(parseInt(days) || 14, 7), 365);
  const startDate = new Date(Date.now() - numDays * 86400000).toISOString().split('T')[0];
  const endDate = new Date().toISOString().split('T')[0];

  // Get income entries with offset transfers in range
  const incomeRows = (await db.query(
    `SELECT ie.id, ie.user_id, ie.amount, ie.net_amount, ie.pay_date, ie.pay_type,
            ie.retention_amount, ie.offset_transfer, u.display_name as user_name
     FROM income_entries ie
     JOIN users u ON ie.user_id = u.id
     WHERE ie.pay_date >= $1 AND ie.pay_date <= $2
     ORDER BY ie.pay_date ASC`,
    [startDate, endDate]
  )).rows;

  // Get goal contributions for these income entries
  const incomeIds = incomeRows.map(r => r.id);
  let goalContribs = [];
  if (incomeIds.length > 0) {
    goalContribs = (await db.query(
      `SELECT gc.income_entry_id, gc.amount, gc.goal_id, sg.name as goal_name
       FROM goal_contributions gc
       JOIN savings_goals sg ON gc.goal_id = sg.id
       WHERE gc.income_entry_id = ANY($1)`,
      [incomeIds]
    )).rows;
  }

  // Get mortgage debit dates (23rd of each month in range)
  const mortgage = 4656.64;
  const mortgageEvents = [];
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  const cursor = new Date(start.getFullYear(), start.getMonth(), 23);
  if (cursor < start) cursor.setMonth(cursor.getMonth() + 1);
  while (cursor <= end) {
    mortgageEvents.push({
      date: cursor.toISOString().split('T')[0],
      amount: mortgage,
      type: 'mortgage_debit'
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  // Combine into events by date
  const events = {};

  for (const ie of incomeRows) {
    if (!events[ie.pay_date]) events[ie.pay_date] = { date: ie.pay_date, paydays: [], mortgage_debit: null };
    const contribs = goalContribs.filter(gc => gc.income_entry_id === ie.id);
    events[ie.pay_date].paydays.push({
      user_name: ie.user_name,
      net_pay: ie.net_amount || ie.amount,
      offset_transfer: ie.offset_transfer || 0,
      retention: ie.retention_amount || 0,
      goal_allocations: contribs.map(gc => ({ goal_name: gc.goal_name, amount: gc.amount }))
    });
  }

  for (const me of mortgageEvents) {
    if (!events[me.date]) events[me.date] = { date: me.date, paydays: [], mortgage_debit: null };
    events[me.date].mortgage_debit = me.amount;
  }

  res.json({
    events: Object.values(events).sort((a, b) => a.date.localeCompare(b.date)),
    mortgage_monthly: mortgage
  });
}));

// ===================== AUTO-MORTGAGE DEBIT =====================

// Apply pending mortgage debits to offset balance (runs on dashboard load)
async function applyPendingMortgageDebits(db) {
  const mortgage = 4656.64;
  const today = new Date();

  // Check if we've initialized past mortgage records
  // The current balance ($58,236.51) ALREADY reflects all past mortgage debits,
  // so we only seed records (not deduct) for past months, and only deduct going forward
  const anyExisting = (await db.query(
    "SELECT COUNT(*) as cnt FROM fund_allocations WHERE target_account = 'offset' AND notes LIKE 'Mortgage%'"
  )).rows[0];

  const admin = (await db.query("SELECT id FROM users WHERE username = 'adam'")).rows[0];
  const userId = admin?.id || 1;

  if (parseInt(anyExisting.cnt) === 0) {
    // First run: seed all past 23rds as "already applied" (balance already reflects them)
    for (let y = 2026; y <= today.getFullYear(); y++) {
      for (let m = 0; m < 12; m++) {
        const debitDate = new Date(y, m, 23);
        if (debitDate > today) break;
        const dateStr = debitDate.toISOString().split('T')[0];
        if (dateStr < '2026-01-01') continue;
        await db.query(
          "INSERT INTO fund_allocations (user_id, target_account, amount, allocated_date, notes) VALUES ($1, 'offset', $2, $3, 'Mortgage auto-debit (historical)')",
          [userId, -mortgage, dateStr]
        );
      }
    }
    return 0; // No balance adjustments — already reflected
  }

  // Subsequent runs: only apply NEW mortgage debits (23rds that have passed since last check)
  const debitsToApply = [];
  for (let y = 2026; y <= today.getFullYear(); y++) {
    for (let m = 0; m < 12; m++) {
      const debitDate = new Date(y, m, 23);
      if (debitDate > today) break;
      const dateStr = debitDate.toISOString().split('T')[0];
      if (dateStr < '2026-01-01') continue;

      const existing = (await db.query(
        "SELECT id FROM fund_allocations WHERE target_account = 'offset' AND notes LIKE 'Mortgage%' AND allocated_date = $1",
        [dateStr]
      )).rows[0];

      if (!existing) {
        debitsToApply.push(dateStr);
      }
    }
  }

  for (const dateStr of debitsToApply) {
    await db.query(
      "INSERT INTO fund_allocations (user_id, target_account, amount, allocated_date, notes) VALUES ($1, 'offset', $2, $3, 'Mortgage auto-debit')",
      [userId, -mortgage, dateStr]
    );
    // Deduct from offset balance
    const offsetRow = (await db.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
    const currentBal = offsetRow ? offsetRow.balance : 0;
    await db.query("INSERT INTO account_balances (account_type, balance, updated_by) VALUES ('offset', $1, $2)",
      [currentBal - mortgage, userId]);
  }

  return debitsToApply.length;
}

// ===================== CLAUDE AI ROUTES =====================

app.post('/api/claude/payday-advice', authMiddleware, asyncHandler(async (req, res) => {
  const { net_pay, retention_data } = req.body;
  const db = await getDb();
  const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];

  const offsetRow = (await db.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
  const offsetBalance = offsetRow ? offsetRow.balance : 0;

  const goals = (await db.query('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
  const recentExpenses = (await db.query('SELECT * FROM expenses WHERE expense_date >= $1 ORDER BY expense_date DESC', [twoWeeksAgo])).rows;
  const upcomingExpenses = (await db.query('SELECT * FROM upcoming_expenses WHERE resolved = 0 ORDER BY expected_date ASC')).rows;

  try {
    const result = await getPayDayAdvice({
      user, netPay: net_pay, retentionData: retention_data, offsetBalance, goals, recentExpenses, upcomingExpenses
    });
    await db.query('INSERT INTO claude_advice (advice_type, content, context_data) VALUES ($1, $2, $3)',
      ['payday', result.advice, JSON.stringify({ net_pay, user_id: req.user.id })]
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

app.post('/api/claude/account-sweep', authMiddleware, asyncHandler(async (req, res) => {
  const { transaction_balance } = req.body;
  const db = await getDb();
  const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];

  const offsetRow = (await db.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
  const offsetBalance = offsetRow ? offsetRow.balance : 0;

  const goals = (await db.query('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;
  const levers = (await db.query('SELECT * FROM levers WHERE active = 1')).rows;
  const budgets = (await db.query('SELECT * FROM category_budgets')).rows;
  const budgetScale = (levers.find(l => l.name.includes('Budget Scale'))?.value || 100) / 100;

  const thirtyDaysAgo = clampDate(new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]);
  const recentExpenses = (await db.query('SELECT * FROM expenses WHERE expense_date >= $1 ORDER BY expense_date DESC', [thirtyDaysAgo])).rows;
  const upcomingExpenses = (await db.query('SELECT * FROM upcoming_expenses WHERE resolved = 0 ORDER BY expected_date ASC')).rows;

  try {
    const result = await getAccountSweepAdvice({
      user, transactionBalance: transaction_balance, offsetBalance, goals, recentExpenses, upcomingExpenses, budgets, budgetScale
    });
    await db.query('INSERT INTO claude_advice (advice_type, content, context_data) VALUES ($1, $2, $3)',
      ['account-sweep', result.advice, JSON.stringify({ transaction_balance, user_id: req.user.id })]
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// ===================== CREDIT CARD STATEMENT IMPORT =====================

app.post('/api/statements/parse', authMiddleware, asyncHandler(async (req, res) => {
  const { csv_text } = req.body;
  if (!csv_text || !csv_text.trim()) {
    return res.status(400).json({ error: 'No CSV data provided' });
  }

  // Load learned category rules for auto-categorization
  const learnedRules = await getCategoryRules();

  const lines = csv_text.trim().split('\n');
  if (lines.length < 2) {
    return res.status(400).json({ error: 'CSV needs at least a header row and one data row' });
  }

  // Parse header row
  const headerLine = lines[0];
  const headers = parseCSVLine(headerLine).map(h => h.toLowerCase().trim());

  // Try to detect column mappings
  const dateCol = headers.findIndex(h => /date/.test(h));
  const amountCol = headers.findIndex(h => /amount|debit|value/.test(h));
  const descCol = headers.findIndex(h => /description|details|narrative|memo|merchant|transaction/.test(h));
  const creditCol = headers.findIndex(h => /credit/.test(h));
  const debitCol = headers.findIndex(h => /debit/.test(h));

  if (dateCol === -1) {
    return res.status(400).json({ error: 'Could not find a date column. Expected a header containing "date".' });
  }
  if (amountCol === -1 && debitCol === -1) {
    return res.status(400).json({ error: 'Could not find an amount column. Expected a header containing "amount", "debit", or "value".' });
  }

  const transactions = [];
  const income_transactions = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCSVLine(line);
    const rawDate = cols[dateCol]?.trim();
    const description = cols[descCol >= 0 ? descCol : 0]?.trim() || '';

    // Parse amount — handle debit/credit columns or single amount
    let amount = 0;
    let isCredit = false;
    if (debitCol >= 0 && creditCol >= 0) {
      const debit = parseFloat((cols[debitCol] || '').replace(/[$,]/g, '')) || 0;
      const credit = parseFloat((cols[creditCol] || '').replace(/[$,]/g, '')) || 0;
      if (debit > 0) { amount = debit; }
      else if (credit > 0) { amount = credit; isCredit = true; }
    } else {
      const raw = parseFloat((cols[amountCol] || '').replace(/[$,]/g, '')) || 0;
      if (raw < 0) { amount = Math.abs(raw); isCredit = true; }
      else { amount = raw; }
    }

    // Skip zero-amount rows
    if (amount <= 0) continue;

    // Parse date — try common formats
    const parsedDate = parseStatementDate(rawDate);
    if (!parsedDate) continue;

    // Detect income/salary patterns
    const dl = description.toLowerCase();
    const isIncome = isCredit || /salary|payroll|wages|pay\s|direct credit|employer|ato\s|tax refund|centrelink|superannuation|dividend|interest\s+(credit|earned)|refund/i.test(dl);

    if (isIncome) {
      income_transactions.push({
        expense_date: parsedDate,
        description: description,
        amount: Math.round(amount * 100) / 100,
        type: 'income',
        source: 'statement'
      });
      continue;
    }

    // Auto-categorize based on description (learned rules first, then built-in)
    const category = autoCategorizeTxn(description, learnedRules);

    transactions.push({
      expense_date: parsedDate,
      description: description,
      amount: Math.round(amount * 100) / 100,
      category: category,
      entry_type: 'actual',
      source: 'credit_card_statement'
    });
  }

  res.json({ transactions, income_transactions, column_mapping: { dateCol, amountCol, descCol, creditCol, debitCol }, row_count: lines.length - 1 });
}));

app.post('/api/statements/import', authMiddleware, asyncHandler(async (req, res) => {
  const { transactions } = req.body;
  if (!transactions || !transactions.length) {
    return res.status(400).json({ error: 'No transactions to import' });
  }

  const db = await getDb();
  const client = await db.connect();
  let importSkipped = 0;
  try {
    await client.query('BEGIN');
    for (const t of transactions) {
      // Check if previously deleted (persistent memory)
      const wasDeleted = (await client.query('SELECT COUNT(*) as cnt FROM deleted_expenses WHERE description = $1 AND amount = $2 AND expense_date = $3', [t.description, t.amount, t.expense_date])).rows[0];
      if (parseInt(wasDeleted.cnt) > 0) { importSkipped++; continue; }
      await client.query(
        'INSERT INTO expenses (user_id, category, subcategory, description, amount, expense_date, entry_type, is_range, range_low, range_high, recurring) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NULL, NULL, 0)',
        [req.user.id, t.category, t.source || 'credit_card_statement', t.description, t.amount, t.expense_date, t.entry_type || 'actual']
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ message: `${transactions.length} transactions imported as expenses` });
}));

// CSV parsing helper — handles quoted fields
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// Date parsing for statement dates
function parseStatementDate(raw) {
  if (!raw) return null;
  // Try ISO format (2024-01-15)
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // Try DD/MM/YYYY (Australian format)
  let m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  // Try DD/MM/YY
  m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m) return `20${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  // Try "DD Mon YYYY" or "DD Mon YY"
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  m = raw.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})$/);
  if (m) {
    const yr = m[3].length === 2 ? '20' + m[3] : m[3];
    const mo = months[m[2].toLowerCase().substring(0, 3)];
    if (mo) return `${yr}-${mo}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

app.post('/api/claude/nightly-summary', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const thirtyDaysAgo = clampDate(new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]);
  const today = new Date().toISOString().split('T')[0];

  const expenses = (await db.query('SELECT * FROM expenses WHERE expense_date >= $1', [thirtyDaysAgo])).rows;
  const incomes = (await db.query('SELECT * FROM income_entries WHERE pay_date >= $1', [thirtyDaysAgo])).rows;

  const offsetRow = (await db.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
  const offsetBalance = offsetRow ? offsetRow.balance : 0;

  const goals = (await db.query('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;

  try {
    const result = await getNightlySummary({
      expenses, incomes, offsetBalance, goals, period: `${thirtyDaysAgo} to ${today}`
    });
    await db.query('INSERT INTO claude_advice (advice_type, content) VALUES ($1, $2)', ['nightly', result.summary]);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

app.get('/api/claude/latest-advice', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const { type } = req.query;
  let query = 'SELECT * FROM claude_advice';
  const params = [];
  if (type) { query += ' WHERE advice_type = $1'; params.push(type); }
  query += ' ORDER BY created_at DESC LIMIT 1';
  const row = (await db.query(query, params)).rows[0];
  res.json(row || { content: 'No advice generated yet. Click "Get Claude Advice" to generate.', advice_type: type || 'nightly' });
}));

// ===================== SCREENSHOT TRANSACTION IMPORT =====================

app.post('/api/screenshots/extract', authMiddleware, asyncHandler(async (req, res) => {
  try {
    const { image, media_type } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });

    const result = await extractTransactionsFromImage(image, media_type || 'image/png');
    if (result.error) return res.status(500).json({ error: result.error });

    // Auto-categorize each extracted transaction (using learned rules)
    const learnedRules = await getCategoryRules();
    const categorized = result.transactions.map(t => ({
      ...t,
      category: autoCategorizeTxn(t.description, learnedRules)
    }));

    res.json({ transactions: categorized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

app.post('/api/screenshots/import', authMiddleware, asyncHandler(async (req, res) => {
  try {
    const db = await getDb();
    const { transactions } = req.body;
    if (!transactions || !transactions.length) return res.status(400).json({ error: 'No transactions to import' });

    const userId = req.user.id;

    function parseDate(dateStr) {
      const [day, month, year] = dateStr.split('/');
      const fullYear = year.length === 4 ? year : (parseInt(year) < 50 ? `20${year}` : `19${year}`);
      return `${fullYear}-${month}-${day}`;
    }

    let added = 0, skipped = 0;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const t of transactions) {
        const date = parseDate(t.date);
        const category = t.category || autoCategorizeTxn(t.description);
        const existing = (await client.query('SELECT COUNT(*) as cnt FROM expenses WHERE user_id = $1 AND description = $2 AND amount = $3 AND expense_date = $4', [userId, t.description, t.amount, date])).rows[0];
        if (parseInt(existing.cnt) > 0) { skipped++; continue; }
        // Check if this was previously deleted (persistent memory)
        const wasDeleted = (await client.query('SELECT COUNT(*) as cnt FROM deleted_expenses WHERE description = $1 AND amount = $2 AND expense_date = $3', [t.description, t.amount, date])).rows[0];
        if (parseInt(wasDeleted.cnt) > 0) { skipped++; continue; }
        await client.query('INSERT INTO expenses (user_id, category, description, amount, expense_date, entry_type, recurring) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [userId, category, t.description, t.amount, date, 'actual', 0]);
        added++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ added, skipped, total: added + skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// ===================== CATEGORY BUDGETS =====================

app.get('/api/budgets', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  res.json((await db.query('SELECT * FROM category_budgets ORDER BY category')).rows);
}));

app.put('/api/budgets/:category', authMiddleware, asyncHandler(async (req, res) => {
  const { monthly_amount } = req.body;
  const db = await getDb();
  await db.query('UPDATE category_budgets SET monthly_amount = $1, updated_at = NOW() WHERE category = $2', [monthly_amount, req.params.category]);
  const row = (await db.query('SELECT * FROM category_budgets WHERE category = $1', [req.params.category])).rows[0];
  res.json(row);
}));

// ===================== INSIGHTS (Household Pulse) =====================

app.get('/api/insights', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysAgo = clampDate(new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]);

  // Per-user activity
  const users = (await db.query('SELECT id, display_name, username FROM users')).rows;
  const userActivity = [];
  for (const u of users) {
    const lastExpense = (await db.query('SELECT expense_date FROM expenses WHERE user_id = $1 ORDER BY expense_date DESC LIMIT 1', [u.id])).rows[0];
    const monthCount = (await db.query('SELECT COUNT(*) as cnt FROM expenses WHERE user_id = $1 AND expense_date >= $2', [u.id, thirtyDaysAgo])).rows[0];
    const monthTotal = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE user_id = $1 AND expense_date >= $2', [u.id, thirtyDaysAgo])).rows[0];

    // Streak: consecutive days with at least one expense
    let streak = 0;
    for (let d = 0; d < 60; d++) {
      const date = new Date(Date.now() - d * 86400000).toISOString().split('T')[0];
      const has = (await db.query('SELECT COUNT(*) as cnt FROM expenses WHERE user_id = $1 AND expense_date = $2', [u.id, date])).rows[0];
      if (parseInt(has.cnt) > 0) streak++;
      else if (d > 0) break;
    }

    const daysSince = lastExpense
      ? Math.floor((Date.now() - new Date(lastExpense.expense_date + 'T12:00:00').getTime()) / 86400000)
      : null;

    userActivity.push({
      user_id: u.id,
      display_name: u.display_name,
      last_expense_date: lastExpense?.expense_date || null,
      days_since_last: daysSince,
      month_count: parseInt(monthCount.cnt),
      month_total: parseFloat(monthTotal.total) || 0,
      streak,
    });
  }

  // Spending pace
  const totalMonth = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1', [thirtyDaysAgo])).rows[0];
  const daysElapsed = Math.max(1, Math.floor((Date.now() - new Date(thirtyDaysAgo + 'T00:00:00').getTime()) / 86400000));
  const dailyAvg = (parseFloat(totalMonth.total) || 0) / daysElapsed;

  // Daily spending (last 14 days, clamped to DATA_START_DATE)
  const fourteenAgo = clampDate(new Date(Date.now() - 13 * 86400000).toISOString().split('T')[0]);
  const dailySpending = [];

  // Fetch payday events for this range
  const payEventsRaw = (await db.query(
    `SELECT ie.pay_date, ie.offset_transfer, ie.retention_amount, ie.net_amount, ie.amount, u.display_name as user_name
     FROM income_entries ie JOIN users u ON ie.user_id = u.id
     WHERE ie.pay_date >= $1 AND ie.pay_date <= $2`,
    [fourteenAgo, today]
  )).rows;
  const goalContribsRaw = (await db.query(
    `SELECT gc.income_entry_id, gc.amount, sg.name as goal_name, ie.pay_date
     FROM goal_contributions gc
     JOIN savings_goals sg ON gc.goal_id = sg.id
     JOIN income_entries ie ON gc.income_entry_id = ie.id
     WHERE ie.pay_date >= $1 AND ie.pay_date <= $2`,
    [fourteenAgo, today]
  )).rows;

  // Mortgage events (23rd of month)
  const mortgage14 = 4656.64;
  const mortgageDates = new Set();
  {
    const s = new Date(fourteenAgo + 'T00:00:00');
    const e = new Date(today + 'T00:00:00');
    const c = new Date(s.getFullYear(), s.getMonth(), 23);
    if (c < s) c.setMonth(c.getMonth() + 1);
    while (c <= e) {
      mortgageDates.add(c.toISOString().split('T')[0]);
      c.setMonth(c.getMonth() + 1);
    }
  }

  for (let d = 13; d >= 0; d--) {
    const date = new Date(Date.now() - d * 86400000).toISOString().split('T')[0];
    if (date < DATA_START_DATE) continue;
    const row = (await db.query('SELECT SUM(amount) as total, COUNT(*) as cnt FROM expenses WHERE expense_date = $1', [date])).rows[0];
    const dayData = { date: date.substring(5), full_date: date, total: parseFloat(row.total) || 0, count: parseInt(row.cnt) };

    // Attach payday events
    const dayPayEvents = payEventsRaw.filter(pe => pe.pay_date === date);
    if (dayPayEvents.length > 0) {
      dayData.payday = dayPayEvents.map(pe => ({
        user_name: pe.user_name,
        net_pay: pe.net_amount || pe.amount,
        offset_transfer: pe.offset_transfer || 0,
        retention: pe.retention_amount || 0,
        goals: goalContribsRaw.filter(gc => gc.pay_date === date).map(gc => ({ name: gc.goal_name, amount: gc.amount }))
      }));
      dayData.total_offset_transfer = dayPayEvents.reduce((s, pe) => s + (pe.offset_transfer || 0), 0);
    }

    // Attach mortgage events
    if (mortgageDates.has(date)) {
      dayData.mortgage_debit = mortgage14;
    }

    dailySpending.push(dayData);
  }

  // Top 5 biggest expenses this month
  const biggestExpenses = (await db.query(
    'SELECT e.category, e.description, e.amount, e.expense_date, u.display_name as user_name FROM expenses e JOIN users u ON e.user_id = u.id WHERE e.expense_date >= $1 ORDER BY e.amount DESC LIMIT 5',
    [thirtyDaysAgo]
  )).rows;

  // Recent 5 expenses
  const recentExpenses = (await db.query(
    'SELECT e.id, e.category, e.description, e.amount, e.expense_date, u.display_name as user_name FROM expenses e JOIN users u ON e.user_id = u.id ORDER BY e.created_at DESC, e.id DESC LIMIT 5'
  )).rows;

  // Offset interest insight
  const offsetRow = (await db.query("SELECT balance FROM account_balances WHERE account_type = $1 ORDER BY updated_at DESC LIMIT 1", ['offset'])).rows[0];
  const offsetBal = offsetRow ? offsetRow.balance : 0;
  const mortgageRate = 0.062;
  const monthlyInterestSaved = (offsetBal * mortgageRate) / 12;
  const annualInterestSaved = offsetBal * mortgageRate;

  // Budget data for pace comparison
  const budgets = (await db.query('SELECT * FROM category_budgets')).rows;
  const levers = (await db.query('SELECT * FROM levers WHERE active = 1')).rows;
  const budgetScale = (levers.find(l => l.name.includes('Budget Scale'))?.value || 100) / 100;
  const monthlyBudget = budgets.reduce((sum, b) => sum + b.monthly_amount * budgetScale, 0);

  res.json({
    user_activity: userActivity,
    spending_pace: {
      daily_average: Math.round(dailyAvg),
      projected_monthly: Math.round(dailyAvg * 30),
      monthly_budget: Math.round(monthlyBudget),
      days_elapsed: daysElapsed,
      total_spent: Math.round(parseFloat(totalMonth.total) || 0),
    },
    daily_spending: dailySpending,
    biggest_expenses: biggestExpenses,
    recent_expenses: recentExpenses,
    offset_insights: {
      balance: offsetBal,
      monthly_interest_saved: Math.round(monthlyInterestSaved),
      annual_interest_saved: Math.round(annualInterestSaved),
      mortgage_rate: mortgageRate,
    },
  });
}));

// ===================== DAILY SPENDING (custom range) =====================

app.get('/api/daily-spending', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const { days } = req.query;
  const numDays = Math.min(Math.max(parseInt(days) || 14, 7), 365);
  const today = new Date().toISOString().split('T')[0];
  const startDate = clampDate(new Date(Date.now() - (numDays - 1) * 86400000).toISOString().split('T')[0]);

  // Fetch payday events for range
  const payEventsRaw = (await db.query(
    `SELECT ie.pay_date, ie.offset_transfer, ie.retention_amount, ie.net_amount, ie.amount, u.display_name as user_name
     FROM income_entries ie JOIN users u ON ie.user_id = u.id
     WHERE ie.pay_date >= $1 AND ie.pay_date <= $2`,
    [startDate, today]
  )).rows;
  const goalContribsRaw = (await db.query(
    `SELECT gc.amount, sg.name as goal_name, ie.pay_date
     FROM goal_contributions gc
     JOIN savings_goals sg ON gc.goal_id = sg.id
     JOIN income_entries ie ON gc.income_entry_id = ie.id
     WHERE ie.pay_date >= $1 AND ie.pay_date <= $2`,
    [startDate, today]
  )).rows;

  // Mortgage events
  const mortgageAmt = 4656.64;
  const mortgageDates = new Set();
  {
    const s = new Date(startDate + 'T00:00:00');
    const e = new Date(today + 'T00:00:00');
    const c = new Date(s.getFullYear(), s.getMonth(), 23);
    if (c < s) c.setMonth(c.getMonth() + 1);
    while (c <= e) {
      mortgageDates.add(c.toISOString().split('T')[0]);
      c.setMonth(c.getMonth() + 1);
    }
  }

  const dailySpending = [];
  for (let d = numDays - 1; d >= 0; d--) {
    const date = new Date(Date.now() - d * 86400000).toISOString().split('T')[0];
    if (date < DATA_START_DATE) continue;
    const row = (await db.query('SELECT SUM(amount) as total, COUNT(*) as cnt FROM expenses WHERE expense_date = $1', [date])).rows[0];
    const dayData = { date: date.substring(5), full_date: date, total: parseFloat(row.total) || 0, count: parseInt(row.cnt) };

    const dayPayEvents = payEventsRaw.filter(pe => pe.pay_date === date);
    if (dayPayEvents.length > 0) {
      dayData.payday = dayPayEvents.map(pe => ({
        user_name: pe.user_name,
        net_pay: pe.net_amount || pe.amount,
        offset_transfer: pe.offset_transfer || 0,
        retention: pe.retention_amount || 0,
        goals: goalContribsRaw.filter(gc => gc.pay_date === date).map(gc => ({ name: gc.goal_name, amount: gc.amount }))
      }));
      dayData.total_offset_transfer = dayPayEvents.reduce((s, pe) => s + (pe.offset_transfer || 0), 0);
    }
    if (mortgageDates.has(date)) {
      dayData.mortgage_debit = mortgageAmt;
    }

    dailySpending.push(dayData);
  }

  const earliest = (await db.query('SELECT MIN(expense_date) as min_date FROM expenses')).rows[0];

  res.json({
    daily_spending: dailySpending,
    earliest_date: earliest?.min_date || null,
  });
}));

// ===================== DASHBOARD / SUMMARY =====================

app.get('/api/dashboard', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();

  // Auto-apply any pending mortgage debits
  await applyPendingMortgageDebits(db);

  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysAgo = clampDate(new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]);
  const sevenDaysAgo = clampDate(new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]);

  const monthlyExpenses = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1', [thirtyDaysAgo])).rows[0];
  const weeklyExpenses = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1', [sevenDaysAgo])).rows[0];
  const monthlyIncome = (await db.query('SELECT SUM(COALESCE(net_amount, amount)) as total FROM income_entries WHERE pay_date >= $1', [thirtyDaysAgo])).rows[0];

  const expensesByCategory = (await db.query(
    'SELECT category, SUM(amount) as total, COUNT(*) as count FROM expenses WHERE expense_date >= $1 GROUP BY category ORDER BY total DESC',
    [thirtyDaysAgo]
  )).rows.map(r => ({ ...r, total: parseFloat(r.total), count: parseInt(r.count) }));

  // Build Monday-based weeks
  const weeklyTrend = [];
  const now = new Date();
  const todayDay = now.getDay();
  const diffToMonday = todayDay === 0 ? 6 : todayDay - 1;
  const thisMonday = new Date(now);
  thisMonday.setDate(thisMonday.getDate() - diffToMonday);
  thisMonday.setHours(0, 0, 0, 0);

  for (let i = 3; i >= 0; i--) {
    const weekStart = new Date(thisMonday);
    weekStart.setDate(weekStart.getDate() - i * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const startStr = weekStart.toISOString().split('T')[0];
    const endStr = weekEnd.toISOString().split('T')[0];
    const label = `WB ${weekStart.getDate()}/${weekStart.getMonth() + 1}`;
    const row = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1 AND expense_date < $2', [startStr, endStr])).rows[0];
    weeklyTrend.push({ week: label, total: parseFloat(row.total) || 0, start: startStr, end: endStr });
  }

  const accounts = ['offset', 'savings', 'credit_card', 'investment'];
  const balances = {};
  for (const acct of accounts) {
    const row = (await db.query('SELECT balance FROM account_balances WHERE account_type = $1 ORDER BY updated_at DESC LIMIT 1', [acct])).rows[0];
    balances[acct] = row ? row.balance : 0;
  }

  const goals = (await db.query('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;
  const users = (await db.query('SELECT id, display_name, gross_income, pay_cycle FROM users')).rows;

  // Budget data
  const budgets = (await db.query('SELECT * FROM category_budgets')).rows;
  const levers = (await db.query('SELECT * FROM levers WHERE active = 1')).rows;
  const budgetScale = (levers.find(l => l.name.includes('Budget Scale'))?.value || 100) / 100;
  const totalMonthlyBudget = budgets.reduce((sum, b) => sum + b.monthly_amount * budgetScale, 0);
  const weeklyBudget = totalMonthlyBudget * 12 / 52;

  // Estimated monthly income from tax calc
  const allUsers = (await db.query('SELECT * FROM users')).rows;
  let totalAnnualNet = 0;
  for (const u of allUsers) {
    const grossExSuper = u.gross_income / (1 + u.super_rate);
    let tax = 0;
    if (grossExSuper > 190000) tax = 51667 + (grossExSuper - 190000) * 0.45;
    else if (grossExSuper > 135000) tax = 29467 + (grossExSuper - 135000) * 0.37;
    else if (grossExSuper > 45000) tax = 5092 + (grossExSuper - 45000) * 0.325;
    else if (grossExSuper > 18200) tax = (grossExSuper - 18200) * 0.19;
    totalAnnualNet += grossExSuper - tax - (grossExSuper * u.hecs_repayment_rate);
  }
  const estimatedMonthlyIncome = totalAnnualNet / 12;
  const mortgage = 4656.64;
  // Offset-centric: mortgage debited from offset by bank, not subtracted from surplus
  const monthlySurplus = estimatedMonthlyIncome - (parseFloat(monthlyExpenses.total) || 0);

  res.json({
    monthly_expenses: parseFloat(monthlyExpenses.total) || 0,
    weekly_expenses: parseFloat(weeklyExpenses.total) || 0,
    monthly_income: parseFloat(monthlyIncome.total) || 0,
    net_monthly: (parseFloat(monthlyIncome.total) || 0) - (parseFloat(monthlyExpenses.total) || 0),
    expenses_by_category: expensesByCategory,
    weekly_trend: weeklyTrend,
    balances,
    goals,
    users,
    mortgage_monthly: mortgage,
    estimated_monthly_income: Math.round(estimatedMonthlyIncome),
    monthly_surplus: Math.round(monthlySurplus),
    budgeted_expenses: Math.round(totalMonthlyBudget),
    weekly_budget: Math.round(weeklyBudget),
    budget_by_category: budgets.map(b => ({ category: b.category, budget: Math.round(b.monthly_amount * budgetScale) }))
  });
}));

// ===================== DATA BACKUP =====================

// Full JSON backup of all data (for disaster recovery)
app.get('/api/backup', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const backup = {
    exported_at: new Date().toISOString(),
    users: (await db.query('SELECT id, username, display_name, role, gross_income, super_rate, hecs_repayment_rate, pay_cycle FROM users')).rows,
    expenses: (await db.query('SELECT * FROM expenses ORDER BY expense_date DESC')).rows,
    income_entries: (await db.query('SELECT * FROM income_entries ORDER BY pay_date DESC')).rows,
    fund_allocations: (await db.query('SELECT * FROM fund_allocations ORDER BY allocated_date DESC')).rows,
    savings_goals: (await db.query('SELECT * FROM savings_goals')).rows,
    levers: (await db.query('SELECT * FROM levers')).rows,
    account_balances: (await db.query('SELECT * FROM account_balances ORDER BY updated_at DESC')).rows,
    category_budgets: (await db.query('SELECT * FROM category_budgets')).rows,
    upcoming_expenses: (await db.query('SELECT * FROM upcoming_expenses')).rows,
    deleted_expenses: (await db.query('SELECT * FROM deleted_expenses')).rows,
  };
  res.setHeader('Content-Disposition', `attachment; filename=budget_backup_${new Date().toISOString().split('T')[0]}.json`);
  res.json(backup);
}));

// Restore data from JSON backup
app.post('/api/backup/restore', authMiddleware, asyncHandler(async (req, res) => {
  const { backup } = req.body;
  if (!backup || !backup.expenses) {
    return res.status(400).json({ error: 'Invalid backup data' });
  }
  const db = await getDb();
  const client = await db.connect();
  let restored = 0;
  try {
    await client.query('BEGIN');
    for (const e of backup.expenses) {
      // Check if this expense already exists
      const existing = (await client.query(
        'SELECT id FROM expenses WHERE user_id = $1 AND description = $2 AND amount = $3 AND expense_date = $4',
        [e.user_id, e.description, e.amount, e.expense_date]
      )).rows[0];
      if (!existing) {
        await client.query(
          'INSERT INTO expenses (user_id, category, subcategory, description, amount, expense_date, entry_type, is_range, range_low, range_high, recurring) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
          [e.user_id, e.category, e.subcategory || null, e.description, e.amount, e.expense_date, e.entry_type || 'actual', e.is_range || 0, e.range_low || null, e.range_high || null, e.recurring || 0]
        );
        restored++;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ message: `Restored ${restored} expenses`, total_in_backup: backup.expenses.length });
}));

// ===================== EXPORT =====================

app.get('/api/export', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const { start, end } = req.query;
  const s = start || new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
  const e = end || new Date().toISOString().split('T')[0];

  const expenses = (await db.query(
    'SELECT e.expense_date as "Date", u.display_name as "User", e.category as "Category", e.subcategory as "Subcategory", e.description as "Description", e.amount as "Amount", e.entry_type as "Type" FROM expenses e JOIN users u ON e.user_id = u.id WHERE e.expense_date >= $1 AND e.expense_date <= $2 ORDER BY e.expense_date DESC',
    [s, e]
  )).rows;

  const incomes = (await db.query(
    'SELECT i.pay_date as "Date", u.display_name as "User", i.amount as "GrossAmount", i.net_amount as "NetAmount", i.pay_type as "Type", i.notes as "Notes" FROM income_entries i JOIN users u ON i.user_id = u.id WHERE i.pay_date >= $1 AND i.pay_date <= $2 ORDER BY i.pay_date DESC',
    [s, e]
  )).rows;

  const goals = (await db.query(
    'SELECT name as "Goal", target_amount as "Target", current_amount as "Current", priority as "Priority", target_date as "TargetDate" FROM savings_goals WHERE active = 1 ORDER BY priority'
  )).rows;

  const accounts = ['offset', 'savings', 'credit_card', 'investment'];
  const balanceRows = [];
  for (const acct of accounts) {
    const row = (await db.query('SELECT balance FROM account_balances WHERE account_type = $1 ORDER BY updated_at DESC LIMIT 1', [acct])).rows[0];
    balanceRows.push({ Account: acct, Balance: row ? row.balance : 0 });
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(expenses), 'Expenses');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(incomes), 'Income');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(goals), 'Savings Goals');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(balanceRows), 'Account Balances');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename=budget_${s}_to_${e}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
}));

// ===================== PROJECTIONS =====================

app.get('/api/projections', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const users = (await db.query('SELECT * FROM users')).rows;

  // Support multiple spending pace ranges
  const paceDays = Math.min(Math.max(parseInt(req.query.pace_days) || 30, 7), 365);
  const projectionMonths = Math.min(Math.max(parseInt(req.query.months) || 12, 3), 60);
  const paceStart = clampDate(new Date(Date.now() - paceDays * 86400000).toISOString().split('T')[0]);
  const thirtyDaysAgo = clampDate(new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]);
  const paceExpenses = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1', [paceStart])).rows[0];
  const monthlyExpenses = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1', [thirtyDaysAgo])).rows[0];

  // Calculate actual days elapsed for accurate pace
  const actualDaysElapsed = Math.max(1, Math.floor((Date.now() - new Date(paceStart + 'T00:00:00').getTime()) / 86400000));
  const dailySpendRate = (parseFloat(paceExpenses.total) || 0) / actualDaysElapsed;
  const monthlyExpenseAtPace = dailySpendRate * 30.44;

  // Calculate combined net income (rough estimate)
  let totalAnnualNet = 0;
  for (const u of users) {
    const grossExSuper = u.gross_income / (1 + u.super_rate);
    const taxable = grossExSuper;
    let tax = 0;
    if (taxable > 190000) tax = 51667 + (taxable - 190000) * 0.45;
    else if (taxable > 135000) tax = 29467 + (taxable - 135000) * 0.37;
    else if (taxable > 45000) tax = 5092 + (taxable - 45000) * 0.325;
    else if (taxable > 18200) tax = (taxable - 18200) * 0.19;
    const hecsRepayment = taxable * u.hecs_repayment_rate;
    const annualNet = taxable - tax - hecsRepayment;
    totalAnnualNet += annualNet;
  }

  const monthlyNetIncome = totalAnnualNet / 12;
  const monthlyExpenseAvg = parseFloat(monthlyExpenses.total) || 0;
  const mortgage = 4656.64;
  // Use pace-based expenses for projections
  const monthlySurplus = monthlyNetIncome - monthlyExpenseAtPace;

  const offsetRow = (await db.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
  const offsetBalance = offsetRow ? offsetRow.balance : 0;

  const goals = (await db.query('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;
  const levers = (await db.query('SELECT * FROM levers WHERE active = 1')).rows;

  // Budget data
  const budgets = (await db.query('SELECT * FROM category_budgets')).rows;
  const budgetScale = (levers.find(l => l.name.includes('Budget Scale'))?.value || 100) / 100;
  const totalMonthlyBudget = budgets.reduce((sum, b) => sum + b.monthly_amount * budgetScale, 0);
  const budgetedSurplus = monthlyNetIncome - totalMonthlyBudget;

  // Project N months — all surplus goes to offset (minus mortgage auto-debit)
  const projections = [];
  let runningOffset = offsetBalance;
  const paceBasedSurplus = Math.max(0, monthlySurplus);
  const netOffsetGrowth = paceBasedSurplus - mortgage;

  for (let m = 1; m <= projectionMonths; m++) {
    const date = new Date();
    date.setMonth(date.getMonth() + m);
    runningOffset += netOffsetGrowth;
    const mortgageRate = 0.062;
    const monthlyInterestSaved = (runningOffset * mortgageRate) / 12;
    projections.push({
      month: date.toISOString().substring(0, 7),
      offset: Math.round(runningOffset),
      surplus_added: Math.round(paceBasedSurplus),
      mortgage_debited: Math.round(mortgage),
      net_growth: Math.round(netOffsetGrowth),
      interest_saved: Math.round(monthlyInterestSaved),
    });
  }

  // Milestone summaries
  const milestones = {};
  [12, 24, 36, 60].forEach(m => {
    if (m <= projectionMonths && projections[m - 1]) {
      milestones[`${m}mo`] = projections[m - 1].offset;
    }
  });

  // Goal achievement forecast
  const goalForecasts = goals.map(g => {
    const remaining = g.target_amount - g.current_amount;
    const monthlyContrib = Math.max(0, budgetedSurplus) * 0.1; // rough estimate: 10% of surplus per goal
    const monthsToGoal = monthlyContrib > 0 ? Math.ceil(remaining / monthlyContrib) : null;
    return { ...g, months_to_goal: monthsToGoal };
  });

  // Sydney benchmarks
  const sydneyBenchmarks = {
    groceries: { low: 800, mid: 1000, high: 1200, label: 'Groceries' },
    dining_out: { low: 200, mid: 350, high: 500, label: 'Dining Out' },
    transport: { low: 200, mid: 300, high: 400, label: 'Transport' },
    utilities: { low: 250, mid: 350, high: 450, label: 'Utilities' },
    insurance: { low: 200, mid: 275, high: 350, label: 'Insurance' },
    entertainment: { low: 100, mid: 225, high: 300, label: 'Entertainment' },
    health: { low: 100, mid: 200, high: 300, label: 'Health & Fitness' },
    clothing: { low: 80, mid: 150, high: 250, label: 'Clothing' },
    personal_care: { low: 60, mid: 100, high: 150, label: 'Personal Care' },
    subscriptions: { low: 50, mid: 100, high: 150, label: 'Subscriptions' },
    gifts: { low: 50, mid: 100, high: 200, label: 'Gifts' }
  };

  const status = monthlySurplus > 500 ? 'great' : monthlySurplus > 0 ? 'okay' : 'warning';
  const message = monthlySurplus > 500
    ? `You're adding ~$${Math.round(monthlySurplus)}/month to offset. Every dollar saves ${(0.062 * 100).toFixed(1)}% in mortgage interest!`
    : monthlySurplus > 0
    ? `Positive surplus of ~$${Math.round(monthlySurplus)}/month going to offset. Look for ways to grow it.`
    : `Warning: spending exceeds income by ~$${Math.round(Math.abs(monthlySurplus))}/month. Offset balance will shrink.`;

  res.json({
    monthly_net_income: Math.round(monthlyNetIncome),
    monthly_expenses: Math.round(monthlyExpenseAvg),
    monthly_expenses_at_pace: Math.round(monthlyExpenseAtPace),
    pace_days: paceDays,
    daily_spend_rate: Math.round(dailySpendRate),
    mortgage,
    monthly_surplus: Math.round(monthlySurplus),
    budgeted_expenses: Math.round(totalMonthlyBudget),
    budgeted_surplus: Math.round(budgetedSurplus),
    net_offset_growth: Math.round(netOffsetGrowth),
    projections,
    projection_months: projectionMonths,
    milestones,
    offset_balance: offsetBalance,
    goals: goalForecasts,
    benchmarks: sydneyBenchmarks,
    status,
    message
  });
}));

// ===================== WIDGET API (for Scriptable / iPhone) =====================

app.get('/api/widget', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const thirtyDaysAgo = clampDate(new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]);

  // Build Monday-based week boundaries
  const todayDay = now.getDay();
  const diffToMonday = todayDay === 0 ? 6 : todayDay - 1;
  const thisMonday = new Date(now);
  thisMonday.setDate(thisMonday.getDate() - diffToMonday);
  thisMonday.setHours(0, 0, 0, 0);
  const thisMondayStr = thisMonday.toISOString().split('T')[0];
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(lastMonday.getDate() - 7);
  const lastMondayStr = lastMonday.toISOString().split('T')[0];

  const monthlyExpenses = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1', [thirtyDaysAgo])).rows[0];
  const thisWeekExpenses = (await db.query('SELECT SUM(amount) as total, COUNT(*) as count FROM expenses WHERE expense_date >= $1', [thisMondayStr])).rows[0];
  const lastWeekExpenses = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1 AND expense_date < $2', [lastMondayStr, thisMondayStr])).rows[0];
  const todayExpenses = (await db.query('SELECT SUM(amount) as total, COUNT(*) as count FROM expenses WHERE expense_date = $1', [today])).rows[0];

  // Budget data
  const budgets = (await db.query('SELECT * FROM category_budgets')).rows;
  const levers = (await db.query('SELECT * FROM levers WHERE active = 1')).rows;
  const budgetScale = (levers.find(l => l.name.includes('Budget Scale'))?.value || 100) / 100;
  const monthlyBudget = budgets.reduce((sum, b) => sum + b.monthly_amount * budgetScale, 0);
  const weeklyBudget = monthlyBudget * 12 / 52;

  const daysElapsed = Math.max(1, Math.floor((Date.now() - new Date(thirtyDaysAgo + 'T00:00:00').getTime()) / 86400000));
  const totalMonth = parseFloat(monthlyExpenses.total) || 0;
  const dailyAvg = totalMonth / daysElapsed;
  const projectedMonthly = dailyAvg * 30;
  const pacePercent = monthlyBudget > 0 ? Math.round((projectedMonthly / monthlyBudget) * 100) : 0;

  const thisWeekTotal = parseFloat(thisWeekExpenses.total) || 0;
  const lastWeekTotal = parseFloat(lastWeekExpenses.total) || 0;
  const weekChange = lastWeekTotal > 0 ? Math.round(((thisWeekTotal - lastWeekTotal) / lastWeekTotal) * 100) : 0;

  // Per-user last expense tracking + this week comparison
  const users = (await db.query('SELECT id, display_name, username FROM users')).rows;
  const userActivity = [];
  for (const u of users) {
    const lastExpense = (await db.query('SELECT expense_date, created_at FROM expenses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [u.id])).rows[0];
    const monthCount = (await db.query('SELECT COUNT(*) as cnt FROM expenses WHERE user_id = $1 AND expense_date >= $2', [u.id, thirtyDaysAgo])).rows[0];
    const monthTotal = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE user_id = $1 AND expense_date >= $2', [u.id, thirtyDaysAgo])).rows[0];
    const weekTotal = (await db.query('SELECT SUM(amount) as total, COUNT(*) as cnt FROM expenses WHERE user_id = $1 AND expense_date >= $2', [u.id, thisMondayStr])).rows[0];
    const daysSince = lastExpense?.created_at
      ? Math.floor((Date.now() - new Date(lastExpense.created_at).getTime()) / 86400000)
      : null;
    userActivity.push({
      name: u.display_name,
      last_expense_date: lastExpense?.expense_date || null,
      last_added_at: lastExpense?.created_at || null,
      days_since_last: daysSince,
      month_count: parseInt(monthCount.cnt),
      month_total: parseFloat(monthTotal.total) || 0,
      week_total: parseFloat(weekTotal.total) || 0,
      week_count: parseInt(weekTotal.cnt),
    });
  }

  // Top 3 categories this month
  const topCategories = (await db.query(
    'SELECT category, SUM(amount) as total FROM expenses WHERE expense_date >= $1 GROUP BY category ORDER BY total DESC LIMIT 3',
    [thirtyDaysAgo]
  )).rows.map(r => ({ category: r.category, total: parseFloat(r.total) }));

  // Offset balance
  const offsetRow = (await db.query("SELECT balance FROM account_balances WHERE account_type = $1 ORDER BY updated_at DESC LIMIT 1", ['offset'])).rows[0];

  // Daily breakdown for mini sparkline (last 7 days)
  const dailyBreakdown = [];
  for (let d = 6; d >= 0; d--) {
    const date = new Date(Date.now() - d * 86400000).toISOString().split('T')[0];
    if (date < DATA_START_DATE) continue;
    const row = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE expense_date = $1', [date])).rows[0];
    dailyBreakdown.push({ date: date.substring(5), total: parseFloat(row.total) || 0 });
  }

  res.json({
    today_spent: parseFloat(todayExpenses.total) || 0,
    today_count: parseInt(todayExpenses.count),
    this_week_spent: thisWeekTotal,
    last_week_spent: lastWeekTotal,
    week_change: weekChange,
    month_spent: totalMonth,
    daily_average: Math.round(dailyAvg),
    projected_monthly: Math.round(projectedMonthly),
    monthly_budget: Math.round(monthlyBudget),
    weekly_budget: Math.round(weeklyBudget),
    pace_percent: pacePercent,
    under_budget: pacePercent <= 100,
    offset_balance: offsetRow ? offsetRow.balance : 0,
    top_categories: topCategories,
    users: userActivity,
    daily_breakdown: dailyBreakdown,
  });
}));

// ===================== QUICK ADD (for iOS Shortcuts / automation) =====================

app.post('/api/quick-add', authMiddleware, asyncHandler(async (req, res) => {
  const { amount, description, category } = req.body;
  if (!amount || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: 'Amount is required and must be positive' });
  }
  const db = await getDb();
  const learnedRules = await getCategoryRules();
  const resolvedCategory = category || (description ? autoCategorizeTxn(description, learnedRules) : 'Other');
  const expenseDate = new Date().toISOString().split('T')[0];

  const result = await db.query(
    'INSERT INTO expenses (user_id, category, description, amount, expense_date, entry_type, is_range, recurring) VALUES ($1, $2, $3, $4, $5, $6, 0, 0) RETURNING id',
    [req.user.id, resolvedCategory, description || resolvedCategory, parseFloat(amount), expenseDate, 'actual']
  );

  // Learn category rule if a category was explicitly provided
  if (category && category !== 'Other' && description) {
    const pattern = extractSupplierPattern(description);
    if (pattern && pattern.length >= 3) {
      await db.query(
        'INSERT INTO category_rules (supplier_pattern, category, created_by) VALUES ($1, $2, $3) ON CONFLICT (supplier_pattern) DO UPDATE SET category = $2',
        [pattern, category, req.user.id]
      );
    }
  }

  res.json({
    success: true,
    id: result.rows[0].id,
    category: resolvedCategory,
    amount: parseFloat(amount),
    description: description || resolvedCategory,
    date: expenseDate,
    message: `Added $${parseFloat(amount).toFixed(2)} ${resolvedCategory}`
  });
}));

// SPA fallback
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
  });
}

// Global error handler — catches unhandled errors from asyncHandler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Budget server running on port ${PORT}`);
});
