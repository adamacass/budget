require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const { getDb, autoCategorizeTxn, categorizeTxnDetailed, getCategoryRules } = require('./db');
const { generateToken, authMiddleware } = require('./auth');
const { getPayDayAdvice, getNightlySummary, getAccountSweepAdvice, extractTransactionsFromImage } = require('./claude');

const app = express();
const PORT = process.env.PORT || 4000;

// All data analysis starts from this date
const DATA_START_DATE = '2026-01-01';
function clampDate(date) { return date < DATA_START_DATE ? DATA_START_DATE : date; }

// Categories excluded from "core" spending view (large lumpy or non-discretionary items)
const OUTLIER_CATEGORIES = ['Insurance', 'Mortgage', 'Home', 'Transfer'];

// Moving money between your own accounts isn't spending — never count it as such
const NON_SPENDING_CATEGORIES = ['Transfer'];

// Wrap async route handlers so unhandled rejections return 500 instead of crashing
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Centralised mortgage amount — single source of truth from levers table
async function getMortgageMonthly(db) {
  const lever = (await db.query("SELECT value FROM levers WHERE name = 'Mortgage Monthly' AND active = 1 LIMIT 1")).rows[0];
  if (lever) return parseFloat(lever.value);
  // Fallback: sum per-user contributions
  const row = (await db.query('SELECT SUM(mortgage_contribution) as total FROM users')).rows[0];
  return parseFloat(row?.total) || 0;
}

async function getMortgageRate(db) {
  const lever = (await db.query("SELECT value FROM levers WHERE name = 'Mortgage Rate' AND active = 1 LIMIT 1")).rows[0];
  if (lever) return parseFloat(lever.value) / 100;
  return 0.0624;
}

async function getMortgageConfig(db) {
  const levers = (await db.query("SELECT name, value FROM levers WHERE active = 1 AND name LIKE 'Mortgage%'")).rows;
  const find = (name) => levers.find(l => l.name === name);

  const ratePercent = parseFloat(find('Mortgage Rate')?.value) || 6.24;
  const rate = ratePercent / 100;
  const monthlyPayment = parseFloat(find('Mortgage Monthly')?.value) || 4656.64;
  const startDate = find('Mortgage Start Date')?.value || '2025-11-23';
  const termYears = parseFloat(find('Mortgage Term Years')?.value) || 30;
  const termMonths = termYears * 12;
  const monthlyRate = rate / 12;

  const principal = monthlyRate > 0
    ? monthlyPayment * (1 - Math.pow(1 + monthlyRate, -termMonths)) / monthlyRate
    : monthlyPayment * termMonths;

  return { rate, ratePercent, monthlyRate, monthlyPayment, startDate, termYears, termMonths, principal };
}

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
      pay_cycle: user.pay_cycle,
      mortgage_contribution: user.mortgage_contribution || 0
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
  const { display_name, gross_income, super_rate, hecs_repayment_rate, pay_cycle, mortgage_contribution } = req.body;
  const db = await getDb();
  await db.query(
    'UPDATE users SET display_name = COALESCE($1, display_name), gross_income = COALESCE($2, gross_income), super_rate = COALESCE($3, super_rate), hecs_repayment_rate = COALESCE($4, hecs_repayment_rate), pay_cycle = COALESCE($5, pay_cycle), mortgage_contribution = COALESCE($6, mortgage_contribution) WHERE id = $7',
    [display_name, gross_income, super_rate, hecs_repayment_rate, pay_cycle, mortgage_contribution, req.user.id]
  );
  const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
  res.json({ id: user.id, username: user.username, display_name: user.display_name, role: user.role, gross_income: user.gross_income, super_rate: user.super_rate, hecs_repayment_rate: user.hecs_repayment_rate, pay_cycle: user.pay_cycle, mortgage_contribution: user.mortgage_contribution || 0 });
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

// ===================== USERS LIST =====================

app.get('/api/users', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const { rows } = await db.query('SELECT id, username, display_name, role, pay_cycle, mortgage_contribution FROM users ORDER BY id');
  res.json(rows);
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
  const amt = parseFloat(String(amount || '').replace(/[$,]/g, ''));
  if (!amt || isNaN(amt)) return res.status(400).json({ error: 'Invalid or missing amount' });
  const db = await getDb();
  const result = await db.query(
    'INSERT INTO expenses (user_id, category, subcategory, description, amount, expense_date, entry_type, is_range, range_low, range_high, recurring) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
    [req.user.id, category, subcategory || null, description || null, amt, expense_date, entry_type || 'actual', is_range ? 1 : 0, range_low || null, range_high || null, recurring ? 1 : 0]
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
      const amt = parseFloat(String(e.amount || '').replace(/[$,]/g, ''));
      if (!amt || isNaN(amt)) continue;
      await client.query(
        'INSERT INTO expenses (user_id, category, subcategory, description, amount, expense_date, entry_type, is_range, range_low, range_high, recurring) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [req.user.id, e.category, e.subcategory || null, e.description || null, amt, e.expense_date, e.entry_type || 'actual', e.is_range ? 1 : 0, e.range_low || null, e.range_high || null, e.recurring ? 1 : 0]
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

// Re-run categorisation across existing expenses. Preview by default; pass
// apply:true to write. Useful after teaching new rules or improving the engine.
app.post('/api/expenses/recategorize', authMiddleware, asyncHandler(async (req, res) => {
  const { apply, only_uncategorized, since } = req.body || {};
  const db = await getDb();
  const rules = await getCategoryRules();

  const params = [];
  let sql = 'SELECT id, description, category, amount, expense_date FROM expenses WHERE 1=1';
  if (only_uncategorized !== false) { sql += " AND category = 'Other'"; }
  if (since) { params.push(since); sql += ` AND expense_date >= $${params.length}`; }
  sql += ' ORDER BY expense_date DESC';

  const rows = (await db.query(sql, params)).rows;
  const changes = [];
  for (const r of rows) {
    const { category, confidence, matched } = categorizeTxnDetailed(r.description || '', rules);
    if (category !== r.category && confidence !== 'low') {
      changes.push({
        id: r.id,
        description: r.description,
        amount: parseFloat(r.amount),
        expense_date: r.expense_date,
        from: r.category,
        to: category,
        confidence,
        matched,
      });
    }
  }

  if (apply && changes.length) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const c of changes) {
        await client.query('UPDATE expenses SET category = $1 WHERE id = $2', [c.to, c.id]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  res.json({ scanned: rows.length, changes, applied: !!apply && changes.length > 0, change_count: changes.length });
}));

// Merchants that keep landing in "Other" — the highest-value rules to teach
app.get('/api/categorization-gaps', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const rows = (await db.query(
    `SELECT description, COUNT(*) as count, SUM(amount) as total, MAX(expense_date) as last_seen
     FROM expenses WHERE category = 'Other' AND description IS NOT NULL AND description <> ''
     GROUP BY description ORDER BY SUM(amount) DESC LIMIT 40`
  )).rows;
  res.json(rows.map(r => ({
    description: r.description,
    count: parseInt(r.count),
    total: Math.round(parseFloat(r.total) * 100) / 100,
    last_seen: r.last_seen,
    suggested_pattern: String(r.description).toLowerCase().split(/\s+/).slice(0, 2).join(' '),
  })));
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
  const { balance, note, source } = req.body;
  const db = await getDb();
  await db.query(
    'INSERT INTO account_balances (account_type, balance, updated_by, note, source) VALUES ($1, $2, $3, $4, $5)',
    [req.params.account, balance, req.user.id, note || null, source || 'manual']
  );
  res.json({ account: req.params.account, balance });
}));

// ===================== OFFSET: RESET, WITHDRAWALS, LEDGER =====================

async function getOffsetBalance(db) {
  const row = (await db.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
  return row ? parseFloat(row.balance) : 0;
}

// Current offset balance + how much of it is claimed by goal buckets
app.get('/api/offset/summary', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const balance = await getOffsetBalance(db);
  const goals = (await db.query('SELECT id, name, current_amount, target_amount, priority FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;
  const allocated = goals.reduce((s, g) => s + (parseFloat(g.current_amount) || 0), 0);
  const last = (await db.query("SELECT balance, note, source, updated_at FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
  res.json({
    balance,
    allocated_to_goals: Math.round(allocated * 100) / 100,
    unallocated: Math.round((balance - allocated) * 100) / 100,
    over_allocated: allocated > balance,
    last_update: last ? { note: last.note, source: last.source, updated_at: last.updated_at } : null,
    goals: goals.map(g => ({ ...g, current_amount: parseFloat(g.current_amount) || 0 })),
  });
}));

// Reset the offset to an exact figure (e.g. after reconciling with the bank).
// Optionally rescale goal buckets so they never exceed the real balance.
app.post('/api/offset/reset', authMiddleware, asyncHandler(async (req, res) => {
  const { balance, note, rebalance_goals } = req.body;
  const newBalance = parseFloat(String(balance ?? '').replace(/[$,]/g, ''));
  if (isNaN(newBalance) || newBalance < 0) {
    return res.status(400).json({ error: 'Provide a valid, non-negative balance' });
  }

  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const prev = (await client.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
    const previousBalance = prev ? parseFloat(prev.balance) : 0;

    await client.query(
      "INSERT INTO account_balances (account_type, balance, updated_by, note, source) VALUES ('offset', $1, $2, $3, 'reset')",
      [newBalance, req.user.id, note || 'Manual offset reset']
    );

    let rebalanced = null;
    if (rebalance_goals) {
      const goals = (await client.query('SELECT id, current_amount FROM savings_goals WHERE active = 1')).rows;
      const allocated = goals.reduce((s, g) => s + (parseFloat(g.current_amount) || 0), 0);
      if (allocated > newBalance && allocated > 0) {
        // Scale every bucket down proportionally so buckets fit inside the real balance
        const factor = newBalance / allocated;
        for (const g of goals) {
          const scaled = Math.round((parseFloat(g.current_amount) || 0) * factor * 100) / 100;
          await client.query('UPDATE savings_goals SET current_amount = $1 WHERE id = $2', [scaled, g.id]);
          await client.query(
            'INSERT INTO goal_contributions (goal_id, user_id, amount, notes) VALUES ($1, $2, $3, $4)',
            [g.id, req.user.id, scaled, 'Redistribution']
          );
        }
        rebalanced = { factor: Math.round(factor * 10000) / 10000, previous_allocated: allocated };
      }
    }

    await client.query('COMMIT');
    res.json({
      balance: newBalance,
      previous_balance: previousBalance,
      change: Math.round((newBalance - previousBalance) * 100) / 100,
      rebalanced,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Record money taken out of (or put back into) the offset
app.post('/api/offset/withdraw', authMiddleware, asyncHandler(async (req, res) => {
  const { amount, withdrawal_date, reason, category, goal_id, deposit } = req.body;
  const parsed = parseFloat(String(amount ?? '').replace(/[$,]/g, ''));
  if (!parsed || isNaN(parsed) || parsed <= 0) {
    return res.status(400).json({ error: 'Provide a valid amount greater than zero' });
  }
  // A deposit is stored as a negative withdrawal so one table covers both directions
  const signed = deposit ? -Math.abs(parsed) : Math.abs(parsed);
  const date = withdrawal_date || new Date().toISOString().split('T')[0];

  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const prev = (await client.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
    const previousBalance = prev ? parseFloat(prev.balance) : 0;
    const newBalance = Math.max(0, Math.round((previousBalance - signed) * 100) / 100);

    const inserted = (await client.query(
      'INSERT INTO offset_withdrawals (user_id, amount, withdrawal_date, reason, category, goal_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.user.id, signed, date, reason || null, category || 'Other', goal_id || null]
    )).rows[0];

    await client.query(
      "INSERT INTO account_balances (account_type, balance, updated_by, note, source) VALUES ('offset', $1, $2, $3, $4)",
      [newBalance, req.user.id, reason || (deposit ? 'Offset deposit' : 'Offset withdrawal'), deposit ? 'deposit' : 'withdrawal']
    );

    // If it came out of a specific goal bucket, draw that bucket down too
    if (goal_id) {
      const goal = (await client.query('SELECT current_amount FROM savings_goals WHERE id = $1', [goal_id])).rows[0];
      if (goal) {
        const updated = Math.max(0, Math.round(((parseFloat(goal.current_amount) || 0) - signed) * 100) / 100);
        await client.query('UPDATE savings_goals SET current_amount = $1 WHERE id = $2', [updated, goal_id]);
        await client.query(
          'INSERT INTO goal_contributions (goal_id, user_id, amount, notes) VALUES ($1, $2, $3, $4)',
          [goal_id, req.user.id, -signed, reason || (deposit ? 'Offset deposit' : 'Offset withdrawal')]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ withdrawal: inserted, balance: newBalance, previous_balance: previousBalance });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

app.get('/api/offset/withdrawals', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const rows = (await db.query(
    `SELECT w.*, u.display_name as user_name, g.name as goal_name
     FROM offset_withdrawals w
     JOIN users u ON w.user_id = u.id
     LEFT JOIN savings_goals g ON w.goal_id = g.id
     ORDER BY w.withdrawal_date DESC, w.id DESC LIMIT $1`, [limit]
  )).rows.map(r => ({ ...r, amount: parseFloat(r.amount) }));
  res.json(rows);
}));

// Undo a withdrawal: remove the record and add the money back
app.delete('/api/offset/withdrawals/:id', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const w = (await client.query('SELECT * FROM offset_withdrawals WHERE id = $1', [req.params.id])).rows[0];
    if (!w) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Withdrawal not found' }); }

    const prev = (await client.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
    const previousBalance = prev ? parseFloat(prev.balance) : 0;
    const restored = Math.max(0, Math.round((previousBalance + parseFloat(w.amount)) * 100) / 100);

    await client.query('DELETE FROM offset_withdrawals WHERE id = $1', [req.params.id]);
    await client.query(
      "INSERT INTO account_balances (account_type, balance, updated_by, note, source) VALUES ('offset', $1, $2, $3, 'reversal')",
      [restored, req.user.id, `Reversed: ${w.reason || 'withdrawal'}`]
    );

    if (w.goal_id) {
      const goal = (await client.query('SELECT current_amount FROM savings_goals WHERE id = $1', [w.goal_id])).rows[0];
      if (goal) {
        const updated = Math.max(0, Math.round(((parseFloat(goal.current_amount) || 0) + parseFloat(w.amount)) * 100) / 100);
        await client.query('UPDATE savings_goals SET current_amount = $1 WHERE id = $2', [updated, w.goal_id]);
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Withdrawal reversed', balance: restored });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Unified movement history: pay-ins, withdrawals, mortgage debits and manual resets
app.get('/api/offset/ledger', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const days = Math.min(parseInt(req.query.days) || 180, 1000);
  const since = clampDate(new Date(Date.now() - days * 86400000).toISOString().split('T')[0]);

  const payIns = (await db.query(
    `SELECT ie.pay_date as date, ie.offset_transfer as amount, u.display_name as who
     FROM income_entries ie JOIN users u ON ie.user_id = u.id
     WHERE ie.pay_date >= $1 AND COALESCE(ie.offset_transfer, 0) > 0`, [since]
  )).rows.map(r => ({ date: r.date, type: 'pay', label: `Pay transfer — ${r.who}`, amount: parseFloat(r.amount), direction: 'in' }));

  const withdrawals = (await db.query(
    `SELECT w.withdrawal_date as date, w.amount, w.reason, w.category, u.display_name as who, g.name as goal_name
     FROM offset_withdrawals w JOIN users u ON w.user_id = u.id
     LEFT JOIN savings_goals g ON w.goal_id = g.id
     WHERE w.withdrawal_date >= $1`, [since]
  )).rows.map(r => ({
    date: r.date,
    type: parseFloat(r.amount) < 0 ? 'deposit' : 'withdrawal',
    label: r.reason || (parseFloat(r.amount) < 0 ? 'Deposit' : 'Withdrawal') + (r.goal_name ? ` (${r.goal_name})` : ''),
    category: r.category,
    who: r.who,
    amount: Math.abs(parseFloat(r.amount)),
    direction: parseFloat(r.amount) < 0 ? 'in' : 'out',
  }));

  // Mortgage debits are stored as negative allocations — show them as a positive outflow
  const mortgage = (await db.query(
    `SELECT allocated_date as date, amount, notes FROM fund_allocations
     WHERE allocated_date >= $1 AND notes LIKE 'Mortgage%'`, [since]
  )).rows.map(r => ({
    date: r.date,
    type: 'mortgage',
    label: r.notes || 'Mortgage payment',
    amount: Math.abs(parseFloat(r.amount) || 0),
    direction: 'out',
  }));

  const resets = (await db.query(
    `SELECT updated_at::date as date, balance, note, source FROM account_balances
     WHERE account_type = 'offset' AND source IN ('reset', 'reversal') AND updated_at::date >= $1::date`, [since]
  )).rows.map(r => ({
    date: r.date.toISOString().split('T')[0],
    type: r.source,
    label: r.note || 'Balance reset',
    amount: parseFloat(r.balance),
    direction: 'adjust',
  }));

  const movements = [...payIns, ...withdrawals, ...mortgage, ...resets]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const totalIn = movements.filter(m => m.direction === 'in').reduce((s, m) => s + m.amount, 0);
  const totalOut = movements.filter(m => m.direction === 'out').reduce((s, m) => s + m.amount, 0);

  res.json({
    movements,
    since,
    totals: {
      in: Math.round(totalIn),
      out: Math.round(totalOut),
      net: Math.round(totalIn - totalOut),
      withdrawals: Math.round(withdrawals.filter(w => w.direction === 'out').reduce((s, w) => s + w.amount, 0)),
    },
  });
}));

// ===================== PLANNED (FUTURE) WITHDRAWALS — feed projections =====================

app.get('/api/planned-withdrawals', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const rows = (await db.query(
    `SELECT p.*, u.display_name as user_name FROM planned_withdrawals p
     JOIN users u ON p.user_id = u.id WHERE p.active = 1
     ORDER BY COALESCE(p.target_date, '9999-12-31'), p.id`
  )).rows.map(r => ({ ...r, amount: parseFloat(r.amount) }));
  res.json(rows);
}));

app.post('/api/planned-withdrawals', authMiddleware, asyncHandler(async (req, res) => {
  const { label, amount, target_date, recurring, frequency_months } = req.body;
  const parsed = parseFloat(String(amount ?? '').replace(/[$,]/g, ''));
  if (!label || !parsed || isNaN(parsed) || parsed <= 0) {
    return res.status(400).json({ error: 'Provide a label and an amount greater than zero' });
  }
  const db = await getDb();
  const row = (await db.query(
    'INSERT INTO planned_withdrawals (user_id, label, amount, target_date, recurring, frequency_months) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [req.user.id, label, parsed, target_date || null, recurring ? 1 : 0, parseInt(frequency_months) || 0]
  )).rows[0];
  res.json(row);
}));

app.delete('/api/planned-withdrawals/:id', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  await db.query('UPDATE planned_withdrawals SET active = 0 WHERE id = $1', [req.params.id]);
  res.json({ message: 'Planned withdrawal removed' });
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
    const periodsPerYear = user.pay_cycle === 'weekly' ? 52 : user.pay_cycle === 'fortnightly' ? 26 : 12;
    const mortgageMonthly = user.mortgage_contribution || 0;
    const mortgagePerPeriod = mortgageMonthly * 12 / periodsPerYear;
    return res.json({
      user_id: userId,
      retention_method: 'fixed',
      calculated_retention: profile.fixed_amount,
      avg_per_period: profile.fixed_amount,
      buffer_amount: 0,
      upcoming_extra: 0,
      mortgage_per_period: Math.round(mortgagePerPeriod * 100) / 100,
      mortgage_monthly: mortgageMonthly,
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

  // Conservative retention: max of spending-based and budget-based
  const spendingBasedRetention = avgPerPeriod + bufferAmount;

  // Budget-based retention: monthly budgets scaled to pay period
  const budgets = (await db.query('SELECT * FROM category_budgets')).rows;
  const levers = (await db.query("SELECT * FROM levers WHERE active = 1 AND name LIKE '%Budget Scale%'")).rows;
  const budgetScale = (levers[0]?.value || 100) / 100;
  const totalMonthlyBudget = budgets.reduce((sum, b) => sum + b.monthly_amount * budgetScale, 0);
  const budgetPerPeriod = totalMonthlyBudget * 12 / periodsPerYear;
  const budgetBasedRetention = budgetPerPeriod;

  // Use whichever is higher (more conservative) + upcoming
  const baseRetention = Math.max(spendingBasedRetention, budgetBasedRetention);
  const calculatedRetention = baseRetention + upcomingExtra;

  // Mortgage contribution per pay period
  const mortgageMonthly = user.mortgage_contribution || 0;
  const mortgagePerPeriod = mortgageMonthly * 12 / periodsPerYear;

  res.json({
    user_id: userId,
    retention_method: 'auto',
    mortgage_per_period: Math.round(mortgagePerPeriod * 100) / 100,
    mortgage_monthly: mortgageMonthly,
    calculated_retention: Math.round(calculatedRetention * 100) / 100,
    avg_per_period: Math.round(avgPerPeriod * 100) / 100,
    buffer_amount: Math.round(bufferAmount * 100) / 100,
    budget_per_period: Math.round(budgetPerPeriod * 100) / 100,
    spending_based: Math.round(spendingBasedRetention * 100) / 100,
    budget_based: Math.round(budgetBasedRetention * 100) / 100,
    used_budget_floor: budgetBasedRetention > spendingBasedRetention,
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
  const { net_amount, gross_amount, pay_date, pay_type, notes, retention_amount, offset_amount, mortgage_contribution, goal_allocations, for_user_id, is_surplus } = req.body;
  const db = await getDb();
  const client = await db.connect();

  // Allow recording income on behalf of another household member
  const effectiveUserId = for_user_id || req.user.id;

  try {
    await client.query('BEGIN');

    // 1. Record income entry
    const incomeResult = await client.query(
      'INSERT INTO income_entries (user_id, amount, net_amount, pay_date, pay_type, notes, retention_amount, offset_transfer, mortgage_contribution, is_surplus) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
      [effectiveUserId, gross_amount || net_amount, net_amount, pay_date, pay_type || 'regular', notes || null, retention_amount, offset_amount, mortgage_contribution || 0, is_surplus ? 1 : 0]
    );
    const incomeEntry = incomeResult.rows[0];

    // 2. Record offset allocation
    if (offset_amount > 0) {
      await client.query(
        'INSERT INTO fund_allocations (user_id, income_entry_id, target_account, amount, allocated_date, notes) VALUES ($1, $2, $3, $4, $5, $6)',
        [effectiveUserId, incomeEntry.id, 'offset', offset_amount, pay_date, 'Offset transfer (surplus after retention)']
      );

      // Update offset balance
      const existing = (await client.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
      const newBalance = (existing ? existing.balance : 0) + offset_amount;
      await client.query("INSERT INTO account_balances (account_type, balance, updated_by) VALUES ('offset', $1, $2)", [newBalance, effectiveUserId]);
    }

    // 3. Process goal allocations (virtual buckets within offset)
    if (goal_allocations && goal_allocations.length > 0) {
      for (const ga of goal_allocations) {
        if (ga.amount > 0) {
          await client.query(
            'INSERT INTO goal_contributions (goal_id, user_id, amount, income_entry_id, notes, contributed_at) VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))',
            [ga.goal_id, effectiveUserId, ga.amount, incomeEntry.id, ga.notes || 'PayDay contribution', pay_date ? pay_date + 'T12:00:00Z' : null]
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

// ===================== OFFSET CONTRIBUTION BREAKDOWN =====================

app.get('/api/offset-contributions', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();

  // Per-user totals
  const perUser = (await db.query(`
    SELECT u.id, u.display_name, u.pay_cycle, u.mortgage_contribution,
           COUNT(ie.id) as pay_count,
           COALESCE(SUM(ie.offset_transfer), 0) as total_offset,
           COALESCE(SUM(ie.mortgage_contribution), 0) as total_mortgage_contrib,
           COALESCE(SUM(ie.net_amount), 0) as total_net,
           COALESCE(SUM(ie.retention_amount), 0) as total_retained,
           COALESCE(AVG(ie.offset_transfer), 0) as avg_offset_per_pay,
           MAX(ie.pay_date) as last_pay_date
    FROM users u
    LEFT JOIN income_entries ie ON u.id = ie.user_id
    GROUP BY u.id, u.display_name, u.pay_cycle, u.mortgage_contribution
    ORDER BY total_offset DESC
  `)).rows;

  // Monthly breakdown per user (last 6 months)
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0];
  const monthly = (await db.query(`
    SELECT u.display_name,
           TO_CHAR(ie.pay_date::date, 'YYYY-MM') as month,
           SUM(ie.offset_transfer) as offset_total,
           SUM(ie.mortgage_contribution) as mortgage_total,
           COUNT(*) as pay_count
    FROM income_entries ie
    JOIN users u ON ie.user_id = u.id
    WHERE ie.pay_date >= $1
    GROUP BY u.display_name, TO_CHAR(ie.pay_date::date, 'YYYY-MM')
    ORDER BY month ASC, u.display_name
  `, [sixMonthsAgo])).rows;

  const grandTotal = perUser.reduce((s, u) => s + parseFloat(u.total_offset), 0);

  res.json({
    per_user: perUser.map(u => ({
      ...u,
      total_offset: parseFloat(u.total_offset),
      total_mortgage_contrib: parseFloat(u.total_mortgage_contrib),
      total_net: parseFloat(u.total_net),
      total_retained: parseFloat(u.total_retained),
      avg_offset_per_pay: parseFloat(u.avg_offset_per_pay),
      share_pct: grandTotal > 0 ? Math.round(parseFloat(u.total_offset) / grandTotal * 100) : 0
    })),
    monthly,
    grand_total: grandTotal
  });
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

// ===================== GOAL HISTORY (time series for progression charts) =====================

app.get('/api/goal-history', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const goals = (await db.query('SELECT id, name, target_amount, current_amount, created_at FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;

  // Build event-driven time series from goal_contributions
  const history = [];
  for (const goal of goals) {
    const contributions = (await db.query(
      `SELECT gc.amount, gc.contributed_at, gc.notes
       FROM goal_contributions gc
       WHERE gc.goal_id = $1
       ORDER BY gc.contributed_at ASC`,
      [goal.id]
    )).rows;

    // Build cumulative snapshots — each contribution is an event (can be +/-)
    const snapshots = [];
    let running = 0;

    // Group events by date for cleaner data points
    const byDate = {};
    for (const c of contributions) {
      const dateStr = new Date(c.contributed_at).toISOString().split('T')[0];
      if (!byDate[dateStr]) byDate[dateStr] = { adds: 0, deducts: 0, notes: [] };
      const amt = parseFloat(c.amount);
      if (c.notes === 'Redistribution') {
        // Redistribution sets absolute — take last redistribution on that date
        byDate[dateStr].redistribution = amt;
        byDate[dateStr].notes.push('redistribution');
      } else if (amt < 0) {
        byDate[dateStr].deducts += amt;
        byDate[dateStr].notes.push(c.notes || 'deduction');
      } else {
        byDate[dateStr].adds += amt;
        byDate[dateStr].notes.push(c.notes || 'contribution');
      }
    }

    const dates = Object.keys(byDate).sort();
    for (const dateStr of dates) {
      const ev = byDate[dateStr];
      const prevRunning = running;
      if (ev.redistribution !== undefined) {
        // Redistribution sets absolute amount
        running = ev.redistribution;
      } else {
        running += ev.adds + ev.deducts;
      }
      running = Math.max(0, running);

      // Determine event type for labeling
      let eventType = 'contribution';
      if (ev.notes.includes('redistribution')) eventType = 'redistribution';
      else if (ev.deducts < 0 && ev.adds === 0) eventType = 'mortgage';
      else if (ev.deducts < 0) eventType = 'mixed';

      snapshots.push({
        week: dateStr,
        amount: Math.round(running * 100) / 100,
        event: eventType,
        delta: Math.round((running - prevRunning) * 100) / 100
      });
    }

    // Add current state as latest point if not already there
    const today = new Date().toISOString().split('T')[0];
    if (snapshots.length === 0 || snapshots[snapshots.length - 1].week !== today) {
      snapshots.push({ week: today, amount: goal.current_amount, event: 'current', delta: 0 });
    }

    // If only 1 point (today), add goal creation date as starting point
    if (snapshots.length === 1) {
      const createdDate = goal.created_at ? new Date(goal.created_at).toISOString().split('T')[0] : today;
      if (createdDate !== today) {
        snapshots.unshift({ week: createdDate, amount: 0, event: 'created', delta: 0 });
      }
    }

    history.push({
      goal_id: goal.id,
      name: goal.name,
      target_amount: goal.target_amount,
      current_amount: goal.current_amount,
      snapshots
    });
  }

  res.json(history);
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
  const mortgage = await getMortgageMonthly(db);
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
// On each 23rd, deducts the mortgage amount from the offset balance and
// proportionally reduces each savings goal bucket.
async function applyPendingMortgageDebits(db) {
  const mortgage = await getMortgageMonthly(db);
  const today = new Date();

  const admin = (await db.query("SELECT id FROM users WHERE username = 'adam'")).rows[0];
  const userId = admin?.id || 1;

  // Process each past 23rd: ensure fund_allocation, account_balance deduction, and goal deductions all exist
  for (let y = 2026; y <= today.getFullYear(); y++) {
    for (let m = 0; m < 12; m++) {
      const debitDate = new Date(y, m, 23);
      if (debitDate > today) break;
      const dateStr = debitDate.toISOString().split('T')[0];
      if (dateStr < '2026-01-01') continue;

      // 1. Ensure fund_allocation marker exists
      const existingAlloc = (await db.query(
        "SELECT id FROM fund_allocations WHERE target_account = 'offset' AND notes LIKE 'Mortgage%' AND allocated_date = $1",
        [dateStr]
      )).rows[0];
      if (!existingAlloc) {
        await db.query(
          "INSERT INTO fund_allocations (user_id, target_account, amount, allocated_date, notes) VALUES ($1, 'offset', $2, $3, 'Mortgage auto-debit')",
          [userId, -mortgage, dateStr]
        );
      }

      // 2. Ensure account_balances has a deduction snapshot for this date
      // Look for a balance drop on this date (mortgage debit marker)
      const balOnDate = (await db.query(
        "SELECT id FROM account_balances WHERE account_type = 'offset' AND updated_at::date = $1::date AND balance < (SELECT balance FROM account_balances WHERE account_type = 'offset' AND updated_at < $1::date ORDER BY updated_at DESC LIMIT 1) LIMIT 1",
        [dateStr]
      )).rows[0];
      if (!balOnDate) {
        // Get the balance just before this date
        const preBal = (await db.query(
          "SELECT balance FROM account_balances WHERE account_type = 'offset' AND updated_at <= $1::timestamptz ORDER BY updated_at DESC LIMIT 1",
          [dateStr + 'T11:59:59Z']
        )).rows[0];
        if (preBal) {
          const newBal = Math.round((preBal.balance - mortgage) * 100) / 100;
          // Only insert if the deduction hasn't already been reflected
          const existingSnap = (await db.query(
            "SELECT id FROM account_balances WHERE account_type = 'offset' AND updated_at::date = $1::date",
            [dateStr]
          )).rows[0];
          if (!existingSnap) {
            await db.query(
              "INSERT INTO account_balances (account_type, balance, updated_by, updated_at) VALUES ('offset', $1, $2, $3::timestamptz)",
              [newBal, userId, dateStr + 'T12:00:00Z']
            );
            console.log(`Mortgage auto-debit ${dateStr}: deducted $${mortgage} from offset, new balance $${newBal}`);
          }
        }
      }

      // 3. Ensure goal deductions exist
      const existingContrib = (await db.query(
        "SELECT id FROM goal_contributions WHERE notes = 'Mortgage deduction' AND contributed_at::date = $1::date LIMIT 1",
        [dateStr]
      )).rows[0];
      if (!existingContrib) {
        const goals = (await db.query('SELECT id, current_amount FROM savings_goals WHERE active = 1')).rows;
        const totalInBuckets = goals.reduce((s, g) => s + (g.current_amount || 0), 0);

        // The mortgage comes out of the offset as a whole. Goal buckets are only
        // earmarks within it, so spend the UNALLOCATED balance first and touch the
        // buckets only for whatever the unallocated portion couldn't cover.
        // (Without this, a few months of repayments silently zero every goal even
        // while tens of thousands sit unallocated in the offset.)
        const balRow = (await db.query(
          "SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1"
        )).rows[0];
        const offsetBalance = balRow ? parseFloat(balRow.balance) : 0;
        const unallocated = Math.max(0, offsetBalance - totalInBuckets);
        const shortfall = Math.max(0, Math.round((mortgage - unallocated) * 100) / 100);

        if (totalInBuckets > 0 && shortfall > 0) {
          for (const goal of goals) {
            const share = (goal.current_amount || 0) / totalInBuckets;
            const deduction = Math.round(shortfall * share * 100) / 100;
            if (deduction > 0) {
              await db.query(
                "INSERT INTO goal_contributions (goal_id, user_id, amount, notes, contributed_at) VALUES ($1, $2, $3, $4, $5::timestamptz)",
                [goal.id, userId, -deduction, 'Mortgage deduction', dateStr + 'T12:00:00Z']
              );
              await db.query(
                "UPDATE savings_goals SET current_amount = GREATEST(0, current_amount - $1) WHERE id = $2",
                [deduction, goal.id]
              );
            }
          }
        }
      }
    }
  }

  return 0;
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
    const mortgageRate = await getMortgageRate(db);
    const mortgagePayment = await getMortgageMonthly(db);
    const result = await getPayDayAdvice({
      user, netPay: net_pay, retentionData: retention_data, offsetBalance, goals, recentExpenses, upcomingExpenses, mortgageRate, mortgagePayment
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
    const mortgageRate = await getMortgageRate(db);
    const mortgagePayment = await getMortgageMonthly(db);
    const result = await getAccountSweepAdvice({
      user, transactionBalance: transaction_balance, offsetBalance, goals, recentExpenses, upcomingExpenses, budgets, budgetScale, mortgageRate, mortgagePayment
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

  const rawLines = csv_text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim());
  if (rawLines.length === 0) {
    return res.status(400).json({ error: 'No data rows found' });
  }

  const delimiter = sniffDelimiter(rawLines);
  const rows = rawLines.map(l => parseDelimitedLine(l, delimiter));

  // Does row 0 look like headers? (no parseable date and mostly non-numeric)
  const firstRow = rows[0].map(c => c.trim());
  const looksLikeHeader = !firstRow.some(c => parseStatementDate(c))
    && firstRow.filter(c => c && !isNumericCell(c)).length >= 2;

  let headers = [];
  let dataRows = rows;
  if (looksLikeHeader) {
    headers = firstRow.map(h => h.toLowerCase().trim());
    dataRows = rows.slice(1);
  }

  if (dataRows.length === 0) {
    return res.status(400).json({ error: 'Found a header row but no transaction rows beneath it' });
  }

  // Resolve columns from headers where possible, otherwise infer from the data
  const mapping = looksLikeHeader
    ? mapColumnsFromHeaders(headers)
    : inferColumnsFromData(dataRows);

  if (mapping.dateCol === -1) {
    return res.status(400).json({ error: 'Could not find a date column. Add a header containing "date", or check the date format.' });
  }
  if (mapping.amountCol === -1 && mapping.debitCol === -1 && mapping.creditCol === -1) {
    return res.status(400).json({ error: 'Could not find an amount column. Expected a header containing "amount", "debit", "credit" or "value".' });
  }

  const transactions = [];
  const income_transactions = [];
  let skippedRows = 0;

  for (const cols of dataRows) {
    const rawDate = (cols[mapping.dateCol] || '').trim();
    const parsedDate = parseStatementDate(rawDate);
    if (!parsedDate) { skippedRows++; continue; }

    let description = (cols[mapping.descCol >= 0 ? mapping.descCol : 0] || '').trim();
    // Some banks split the merchant across two columns — append the extra one
    if (mapping.descCol2 >= 0 && cols[mapping.descCol2]) {
      const extra = cols[mapping.descCol2].trim();
      if (extra && extra !== description) description = `${description} ${extra}`.trim();
    }
    description = description.replace(/\s+/g, ' ');

    // Work out signed amount: positive = money out, negative = money in
    let signed = null;
    if (mapping.debitCol >= 0 || mapping.creditCol >= 0) {
      const debit = mapping.debitCol >= 0 ? parseAmountCell(cols[mapping.debitCol]) : null;
      const credit = mapping.creditCol >= 0 ? parseAmountCell(cols[mapping.creditCol]) : null;
      if (debit !== null && Math.abs(debit) > 0) signed = Math.abs(debit);
      else if (credit !== null && Math.abs(credit) > 0) signed = -Math.abs(credit);
    }
    if (signed === null && mapping.amountCol >= 0) {
      const val = parseAmountCell(cols[mapping.amountCol]);
      // Most AU exports use negative for money out; flip so positive = spend
      if (val !== null) signed = -val;
    }
    if (signed === null || signed === 0 || isNaN(signed)) { skippedRows++; continue; }

    const amount = Math.round(Math.abs(signed) * 100) / 100;
    const isCredit = signed < 0;

    const dl = description.toLowerCase();
    const looksLikeIncome = /\b(salary|payroll|wages|direct credit|employer|tax refund|centrelink|superannuation|dividend|refund|reimbursement|rebate|ato\b)/i.test(dl);

    if (isCredit || looksLikeIncome) {
      income_transactions.push({
        expense_date: parsedDate,
        description,
        amount,
        type: 'income',
        source: 'statement',
        reason: isCredit ? 'credit' : 'description',
      });
      continue;
    }

    const { category, confidence, matched } = categorizeTxnDetailed(description, learnedRules);
    transactions.push({
      expense_date: parsedDate,
      description,
      amount,
      category,
      confidence,
      matched,
      is_transfer: category === 'Transfer',
      needs_review: confidence === 'low' || category === 'Transfer',
      entry_type: 'actual',
      source: 'credit_card_statement',
    });
  }

  const lowConfidence = transactions.filter(t => t.confidence === 'low').length;
  const transfers = transactions.filter(t => t.is_transfer).length;
  const dates = transactions.map(t => t.expense_date).sort();

  res.json({
    transactions,
    income_transactions,
    column_mapping: mapping,
    delimiter: delimiter === '\t' ? 'tab' : delimiter,
    had_header: looksLikeHeader,
    row_count: dataRows.length,
    skipped_rows: skippedRows,
    summary: {
      parsed: transactions.length,
      income: income_transactions.length,
      low_confidence: lowConfidence,
      transfers,
      total: Math.round(transactions.reduce((s, t) => s + t.amount, 0) * 100) / 100,
      date_from: dates[0] || null,
      date_to: dates[dates.length - 1] || null,
    },
  });
}));

// Pick the delimiter that yields the most consistent column count
function sniffDelimiter(lines) {
  const candidates = [',', '\t', ';', '|'];
  const sample = lines.slice(0, Math.min(10, lines.length));
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    const counts = sample.map(l => parseDelimitedLine(l, d).length);
    const max = Math.max(...counts);
    if (max < 2) continue;
    // Reward many columns, penalise rows that disagree on column count
    const consistent = counts.filter(c => c === max).length;
    const score = max * 10 + consistent;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function isNumericCell(cell) {
  return parseAmountCell(cell) !== null;
}

// Handles "$1,234.56", "(123.45)", "123.45 CR", "-1234.56", "1 234,56"
function parseAmountCell(cell) {
  if (cell === undefined || cell === null) return null;
  let s = String(cell).trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/\bcr\b/i.test(s)) { negative = true; }
  if (/\bdr\b/i.test(s)) { negative = false; }
  s = s.replace(/\b(cr|dr)\b/gi, '');
  s = s.replace(/[$\s ]/g, '');

  // Work out whether ',' is a decimal point or a thousands separator.
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    // Whichever comes last is the decimal separator
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    // A single comma with 1-2 trailing digits is a decimal comma ("45,50");
    // anything else is a thousands separator ("1,234", "1,234,567")
    if (/^-?\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
  }

  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return negative ? -Math.abs(n) : n;
}

function mapColumnsFromHeaders(headers) {
  const find = (re, exclude) => headers.findIndex(h => re.test(h) && !(exclude && exclude.test(h)));
  // "Value Date" must never be read as an amount, and "Balance" is not a transaction amount
  const notDate = /date/;
  const dateCol = find(/date|posted|processed/);
  const debitCol = find(/debit|withdrawal|money out|paid out/);
  const creditCol = find(/credit|deposit|money in|paid in/, /card|limit/);
  let amountCol = find(/amount|value|transaction amount/, notDate);
  if (amountCol === -1) amountCol = find(/^amt$/);
  const descCol = find(/description|details|narrative|memo|merchant|payee|particulars|reference|transaction/, /date|amount|type/);
  const descCol2 = headers.findIndex((h, i) => i !== descCol && /narrative|particulars|reference|memo/.test(h));
  return { dateCol, amountCol, descCol, descCol2, creditCol, debitCol };
}

// No header row: work out which column is which by looking at the data itself
function inferColumnsFromData(dataRows) {
  const sample = dataRows.slice(0, Math.min(20, dataRows.length));
  const colCount = Math.max(...sample.map(r => r.length));
  let dateCol = -1, amountCol = -1, descCol = -1;

  for (let c = 0; c < colCount; c++) {
    const cells = sample.map(r => (r[c] || '').trim()).filter(Boolean);
    if (!cells.length) continue;
    const dateHits = cells.filter(v => parseStatementDate(v)).length;
    const numHits = cells.filter(v => isNumericCell(v)).length;
    if (dateCol === -1 && dateHits >= cells.length * 0.7) { dateCol = c; continue; }
    if (amountCol === -1 && numHits >= cells.length * 0.7) { amountCol = c; continue; }
  }
  // Description = the widest mostly-text column
  let bestLen = 0;
  for (let c = 0; c < colCount; c++) {
    if (c === dateCol || c === amountCol) continue;
    const cells = sample.map(r => (r[c] || '').trim()).filter(Boolean);
    if (!cells.length) continue;
    const textCells = cells.filter(v => !isNumericCell(v));
    if (textCells.length < cells.length * 0.5) continue;
    const avgLen = textCells.reduce((s, v) => s + v.length, 0) / textCells.length;
    if (avgLen > bestLen) { bestLen = avgLen; descCol = c; }
  }
  return { dateCol, amountCol, descCol, descCol2: -1, creditCol: -1, debitCol: -1 };
}

app.post('/api/statements/import', authMiddleware, asyncHandler(async (req, res) => {
  const { transactions } = req.body;
  if (!transactions || !transactions.length) {
    return res.status(400).json({ error: 'No transactions to import' });
  }

  const db = await getDb();
  const client = await db.connect();
  let added = 0;
  let importSkipped = 0;
  try {
    await client.query('BEGIN');
    for (const t of transactions) {
      const amt = parseFloat(String(t.amount || '').replace(/[$,]/g, ''));
      if (!amt || isNaN(amt)) { importSkipped++; continue; }
      // Check if previously deleted (persistent memory)
      const wasDeleted = (await client.query('SELECT COUNT(*) as cnt FROM deleted_expenses WHERE description = $1 AND amount = $2 AND expense_date = $3', [t.description, amt, t.expense_date])).rows[0];
      if (parseInt(wasDeleted.cnt) > 0) { importSkipped++; continue; }
      await client.query(
        'INSERT INTO expenses (user_id, category, subcategory, description, amount, expense_date, entry_type, is_range, range_low, range_high, recurring) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NULL, NULL, 0)',
        [req.user.id, t.category, t.source || 'credit_card_statement', t.description, amt, t.expense_date, t.entry_type || 'actual']
      );
      added++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({
    message: `${added} transaction${added === 1 ? '' : 's'} imported as expenses${importSkipped ? `, ${importSkipped} skipped` : ''}`,
    added,
    skipped: importSkipped,
    total: transactions.length,
  });
}));

// Delimited-line parser — handles quoted fields containing the delimiter
function parseDelimitedLine(line, delimiter = ',') {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// Back-compat alias
function parseCSVLine(line) { return parseDelimitedLine(line, ','); }

const MONTH_NAMES = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// Date parsing for statement dates. Day-first (Australian) is assumed when ambiguous.
function parseStatementDate(raw) {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim().replace(/^"|"$/g, '');
  if (!s) return null;

  // Strip a trailing time component ("2026-03-01 14:22:00", "01/03/2026 2:15 PM")
  s = s.replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?(\s*[ap]\.?m\.?)?$/i, '').trim();

  const valid = (y, m, d) => {
    const yi = parseInt(y), mi = parseInt(m), di = parseInt(d);
    if (mi < 1 || mi > 12 || di < 1 || di > 31) return null;
    if (yi < 1990 || yi > 2100) return null;
    return `${yi}-${String(mi).padStart(2, '0')}-${String(di).padStart(2, '0')}`;
  };

  // ISO: 2026-03-01 or 2026/03/01
  let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) return valid(m[1], m[2], m[3]);

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    // If the first number can't be a day but the second can, it's US-style MM/DD
    if (parseInt(m[1]) > 12 || parseInt(m[2]) <= 12) return valid(m[3], m[2], m[1]);
    return valid(m[3], m[1], m[2]);
  }

  // DD/MM/YY
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/);
  if (m) {
    const yr = parseInt(m[3]) < 70 ? `20${m[3]}` : `19${m[3]}`;
    if (parseInt(m[1]) > 12 || parseInt(m[2]) <= 12) return valid(yr, m[2], m[1]);
    return valid(yr, m[1], m[2]);
  }

  // "01 Mar 2026", "01-Mar-26", "1 March 2026"
  m = s.match(/^(\d{1,2})[\s\-]+([A-Za-z]{3,})[\s\-]+(\d{2,4})$/);
  if (m) {
    const mo = MONTH_NAMES[m[2].toLowerCase().substring(0, 3)];
    const yr = m[3].length === 2 ? (parseInt(m[3]) < 70 ? `20${m[3]}` : `19${m[3]}`) : m[3];
    if (mo) return valid(yr, mo, m[1]);
  }

  // "Mar 01, 2026" / "March 1 2026"
  m = s.match(/^([A-Za-z]{3,})[\s\-]+(\d{1,2}),?[\s\-]+(\d{2,4})$/);
  if (m) {
    const mo = MONTH_NAMES[m[1].toLowerCase().substring(0, 3)];
    const yr = m[3].length === 2 ? (parseInt(m[3]) < 70 ? `20${m[3]}` : `19${m[3]}`) : m[3];
    if (mo) return valid(yr, mo, m[2]);
  }

  // "01 Mar" with no year — assume the most recent occurrence, never the future
  m = s.match(/^(\d{1,2})[\s\-]+([A-Za-z]{3,})$/);
  if (m) {
    const mo = MONTH_NAMES[m[2].toLowerCase().substring(0, 3)];
    if (mo) {
      const now = new Date();
      let yr = now.getFullYear();
      const candidate = valid(yr, mo, m[1]);
      if (candidate && candidate > now.toISOString().split('T')[0]) yr -= 1;
      return valid(yr, mo, m[1]);
    }
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
    const mortgageRate = await getMortgageRate(db);
    const mortgagePayment = await getMortgageMonthly(db);
    const result = await getNightlySummary({
      expenses, incomes, offsetBalance, goals, period: `${thirtyDaysAgo} to ${today}`, mortgageRate, mortgagePayment
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
    const categorized = result.transactions.map(t => {
      const { category, confidence, matched } = categorizeTxnDetailed(t.description || '', learnedRules);
      return {
        ...t,
        category,
        confidence,
        matched,
        is_transfer: category === 'Transfer',
        needs_review: confidence === 'low' || category === 'Transfer',
      };
    });

    res.json({
      transactions: categorized,
      summary: {
        parsed: categorized.length,
        low_confidence: categorized.filter(t => t.confidence === 'low').length,
        transfers: categorized.filter(t => t.is_transfer).length,
      },
    });
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

    let added = 0, skipped = 0;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const t of transactions) {
        const date = parseStatementDate(t.date);
        if (!date) { skipped++; continue; }
        const category = t.category || autoCategorizeTxn(t.description);
        const amt = parseFloat(String(t.amount || '').replace(/[$,]/g, ''));
        if (!amt || isNaN(amt)) { skipped++; continue; }
        const existing = (await client.query('SELECT COUNT(*) as cnt FROM expenses WHERE user_id = $1 AND description = $2 AND amount = $3 AND expense_date = $4', [userId, t.description, amt, date])).rows[0];
        if (parseInt(existing.cnt) > 0) { skipped++; continue; }
        // Check if this was previously deleted (persistent memory)
        const wasDeleted = (await client.query('SELECT COUNT(*) as cnt FROM deleted_expenses WHERE description = $1 AND amount = $2 AND expense_date = $3', [t.description, amt, date])).rows[0];
        if (parseInt(wasDeleted.cnt) > 0) { skipped++; continue; }
        await client.query('INSERT INTO expenses (user_id, category, description, amount, expense_date, entry_type, recurring) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [userId, category, t.description, amt, date, 'actual', 0]);
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

  // Core daily spending (excluding outlier categories) — batch query for the range
  const coreDailyInsights = (await db.query(
    `SELECT expense_date::text, SUM(amount) as core_total FROM expenses WHERE expense_date >= $1 AND expense_date <= $2 AND NOT (category = ANY($3)) GROUP BY expense_date`,
    [fourteenAgo, today, OUTLIER_CATEGORIES]
  )).rows;

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
  const mortgage14 = await getMortgageMonthly(db);
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
    const coreEntry = coreDailyInsights.find(r => r.expense_date === date);
    const dayData = { date: date.substring(5), full_date: date, total: parseFloat(row.total) || 0, core_total: parseFloat(coreEntry?.core_total) || 0, count: parseInt(row.cnt) };

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

  // Month-over-month comparison analytics
  const sixtyDaysAgo = clampDate(new Date(Date.now() - 60 * 86400000).toISOString().split('T')[0]);
  const prevMonthTotalRow = (await db.query(
    'SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1 AND expense_date < $2',
    [sixtyDaysAgo, thirtyDaysAgo]
  )).rows[0];
  const coreMonthTotalRow = (await db.query(
    'SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1 AND NOT (category = ANY($2))',
    [thirtyDaysAgo, OUTLIER_CATEGORIES]
  )).rows[0];
  const prevCoreMonthRow = (await db.query(
    'SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1 AND expense_date < $2 AND NOT (category = ANY($3))',
    [sixtyDaysAgo, thirtyDaysAgo, OUTLIER_CATEGORIES]
  )).rows[0];

  // Core spending pace
  const coreDailyAvg = (parseFloat(coreMonthTotalRow.total) || 0) / daysElapsed;

  // Category trends: current 30d vs previous 30d
  const currentCatRows = (await db.query(
    'SELECT category, SUM(amount) as total FROM expenses WHERE expense_date >= $1 GROUP BY category',
    [thirtyDaysAgo]
  )).rows;
  const previousCatRows = (await db.query(
    'SELECT category, SUM(amount) as total FROM expenses WHERE expense_date >= $1 AND expense_date < $2 GROUP BY category',
    [sixtyDaysAgo, thirtyDaysAgo]
  )).rows;
  const categoryTrends = currentCatRows
    .map(curr => {
      const prev = previousCatRows.find(p => p.category === curr.category);
      const prevTotal = parseFloat(prev?.total) || 0;
      const currTotal = parseFloat(curr.total);
      return {
        category: curr.category,
        current: Math.round(currTotal),
        previous: Math.round(prevTotal),
        change: Math.round(currTotal - prevTotal),
        change_pct: prevTotal > 0 ? Math.round(((currTotal - prevTotal) / prevTotal) * 100) : null,
      };
    })
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  // Offset interest insight
  const offsetRow = (await db.query("SELECT balance FROM account_balances WHERE account_type = $1 ORDER BY updated_at DESC LIMIT 1", ['offset'])).rows[0];
  const offsetBal = offsetRow ? offsetRow.balance : 0;
  const mortgageRate = await getMortgageRate(db);
  const monthlyInterestSaved = (offsetBal * mortgageRate) / 12;
  const annualInterestSaved = offsetBal * mortgageRate;

  // Budget data for pace comparison
  const budgets = (await db.query('SELECT * FROM category_budgets')).rows;
  const levers = (await db.query('SELECT * FROM levers WHERE active = 1')).rows;
  const budgetScale = (levers.find(l => l.name.includes('Budget Scale'))?.value || 100) / 100;
  const monthlyBudget = budgets.reduce((sum, b) => sum + b.monthly_amount * budgetScale, 0);

  // Core budget (total budget minus outlier categories)
  const coreBudget = budgets
    .filter(b => !OUTLIER_CATEGORIES.includes(b.category))
    .reduce((sum, b) => sum + b.monthly_amount * budgetScale, 0);

  res.json({
    user_activity: userActivity,
    spending_pace: {
      daily_average: Math.round(dailyAvg),
      projected_monthly: Math.round(dailyAvg * 30),
      monthly_budget: Math.round(monthlyBudget),
      days_elapsed: daysElapsed,
      total_spent: Math.round(parseFloat(totalMonth.total) || 0),
      core_total_spent: Math.round(parseFloat(coreMonthTotalRow.total) || 0),
      core_daily_average: Math.round(coreDailyAvg),
      core_projected_monthly: Math.round(coreDailyAvg * 30),
      core_monthly_budget: Math.round(coreBudget),
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
    core_monthly_spent: Math.round(parseFloat(coreMonthTotalRow.total) || 0),
    prev_month_total: Math.round(parseFloat(prevMonthTotalRow.total) || 0),
    prev_core_total: Math.round(parseFloat(prevCoreMonthRow.total) || 0),
    category_trends: categoryTrends,
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
  const mortgageAmt = await getMortgageMonthly(db);
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

  // Core daily spending (batch query)
  const coreDailyRange = (await db.query(
    `SELECT expense_date::text, SUM(amount) as core_total FROM expenses WHERE expense_date >= $1 AND expense_date <= $2 AND NOT (category = ANY($3)) GROUP BY expense_date`,
    [startDate, today, OUTLIER_CATEGORIES]
  )).rows;

  const dailySpending = [];
  for (let d = numDays - 1; d >= 0; d--) {
    const date = new Date(Date.now() - d * 86400000).toISOString().split('T')[0];
    if (date < DATA_START_DATE) continue;
    const row = (await db.query('SELECT SUM(amount) as total, COUNT(*) as cnt FROM expenses WHERE expense_date = $1', [date])).rows[0];
    const coreEntry = coreDailyRange.find(r => r.expense_date === date);
    const dayData = { date: date.substring(5), full_date: date, total: parseFloat(row.total) || 0, core_total: parseFloat(coreEntry?.core_total) || 0, count: parseInt(row.cnt) };

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

  const monthlyExpenses = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1 AND NOT (category = ANY($2))', [thirtyDaysAgo, NON_SPENDING_CATEGORIES])).rows[0];
  const coreMonthlyExpenses = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1 AND NOT (category = ANY($2))', [thirtyDaysAgo, OUTLIER_CATEGORIES])).rows[0];
  const weeklyExpenses = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1 AND NOT (category = ANY($2))', [sevenDaysAgo, NON_SPENDING_CATEGORIES])).rows[0];
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

  // Goal weekly change: reconstruct what the bucket held 7 days ago, compare to now
  for (const g of goals) {
    // Get all contributions up to 7 days ago to reconstruct the snapshot
    const allContribs = (await db.query(
      `SELECT amount, notes, contributed_at FROM goal_contributions WHERE goal_id = $1 AND contributed_at <= NOW() - INTERVAL '7 days' ORDER BY contributed_at ASC`,
      [g.id]
    )).rows;
    let amountOneWeekAgo = 0;
    for (const c of allContribs) {
      if (c.notes === 'Redistribution') {
        amountOneWeekAgo = parseFloat(c.amount); // absolute set
      } else {
        amountOneWeekAgo += parseFloat(c.amount); // incremental (+/-)
      }
    }
    amountOneWeekAgo = Math.max(0, amountOneWeekAgo);
    g.weekly_change = (g.current_amount || 0) - amountOneWeekAgo;
  }

  const users = (await db.query('SELECT id, display_name, gross_income, pay_cycle, mortgage_contribution FROM users')).rows;

  // Budget data
  const budgets = (await db.query('SELECT * FROM category_budgets')).rows;
  const levers = (await db.query('SELECT * FROM levers WHERE active = 1')).rows;
  const budgetScale = (levers.find(l => l.name.includes('Budget Scale'))?.value || 100) / 100;
  const totalMonthlyBudget = budgets.reduce((sum, b) => sum + b.monthly_amount * budgetScale, 0);
  const weeklyBudget = totalMonthlyBudget * 12 / 52;

  // Estimated monthly income from tax calc (per-user)
  const allUsers = (await db.query('SELECT * FROM users')).rows;
  let totalAnnualNet = 0;
  const incomeComparison = [];
  for (const u of allUsers) {
    const grossExSuper = u.gross_income / (1 + u.super_rate);
    let tax = 0;
    if (grossExSuper > 190000) tax = 51667 + (grossExSuper - 190000) * 0.45;
    else if (grossExSuper > 135000) tax = 29467 + (grossExSuper - 135000) * 0.37;
    else if (grossExSuper > 45000) tax = 5092 + (grossExSuper - 45000) * 0.325;
    else if (grossExSuper > 18200) tax = (grossExSuper - 18200) * 0.19;
    const annualNet = grossExSuper - tax - (grossExSuper * u.hecs_repayment_rate);
    totalAnnualNet += annualNet;

    // Actual income: average monthly from all recorded pay events
    const incomeStats = (await db.query(
      `SELECT SUM(COALESCE(net_amount, amount)) as total,
              COUNT(*) as pay_count,
              MIN(pay_date) as first_pay,
              MAX(pay_date) as last_pay
       FROM income_entries WHERE user_id = $1`, [u.id]
    )).rows[0];
    const actualTotal = parseFloat(incomeStats.total) || 0;
    let actualMonthly = 0;
    if (incomeStats.pay_count > 0 && incomeStats.first_pay) {
      const first = new Date(incomeStats.first_pay);
      const last = new Date(incomeStats.last_pay);
      const msSpan = last - first;
      const monthsSpan = msSpan / (1000 * 60 * 60 * 24 * 30.44);
      actualMonthly = monthsSpan >= 1 ? actualTotal / monthsSpan : actualTotal;
    }
    incomeComparison.push({
      user_id: u.id,
      display_name: u.display_name,
      estimated_monthly: Math.round(annualNet / 12),
      actual_monthly: Math.round(actualMonthly),
      pay_count: parseInt(incomeStats.pay_count) || 0,
      pay_cycle: u.pay_cycle
    });
  }
  const estimatedMonthlyIncome = totalAnnualNet / 12;
  const mortgage = await getMortgageMonthly(db);
  // Offset-centric: mortgage debited from offset by bank, not subtracted from surplus
  const monthlySurplus = estimatedMonthlyIncome - (parseFloat(monthlyExpenses.total) || 0);

  // Offset balance history: one data point per day (latest snapshot each day)
  const offsetHistory = (await db.query(
    `SELECT DISTINCT ON (updated_at::date) updated_at::date as date, balance
     FROM account_balances WHERE account_type = 'offset'
     ORDER BY updated_at::date, updated_at DESC`
  )).rows.map(r => ({ date: r.date.toISOString().split('T')[0], balance: parseFloat(r.balance) }));

  res.json({
    monthly_expenses: parseFloat(monthlyExpenses.total) || 0,
    core_monthly_expenses: parseFloat(coreMonthlyExpenses.total) || 0,
    weekly_expenses: parseFloat(weeklyExpenses.total) || 0,
    monthly_income: parseFloat(monthlyIncome.total) || 0,
    net_monthly: (parseFloat(monthlyIncome.total) || 0) - (parseFloat(monthlyExpenses.total) || 0),
    expenses_by_category: expensesByCategory,
    weekly_trend: weeklyTrend,
    balances,
    goals,
    users,
    mortgage_monthly: mortgage,
    mortgage_rate: await getMortgageRate(db),
    mortgage_config: await getMortgageConfig(db),
    estimated_monthly_income: Math.round(estimatedMonthlyIncome),
    monthly_surplus: Math.round(monthlySurplus),
    budgeted_expenses: Math.round(totalMonthlyBudget),
    core_budgeted_expenses: Math.round(budgets.filter(b => !OUTLIER_CATEGORIES.includes(b.category)).reduce((sum, b) => sum + b.monthly_amount * budgetScale, 0)),
    weekly_budget: Math.round(weeklyBudget),
    budget_by_category: budgets.map(b => ({ category: b.category, budget: Math.round(b.monthly_amount * budgetScale) })),
    offset_history: offsetHistory,
    income_comparison: incomeComparison
  });
}));

// ===================== DATA BACKUP =====================

// Full JSON backup of all data (for disaster recovery / moving hosts).
// Pass ?include_credentials=1 to include password hashes so the restored copy
// can be logged into with the same passwords.
app.get('/api/backup', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const withCreds = req.query.include_credentials === '1' || req.query.include_credentials === 'true';
  const userCols = withCreds
    ? 'id, username, display_name, password_hash, role, gross_income, super_rate, hecs_repayment_rate, pay_cycle, mortgage_contribution'
    : 'id, username, display_name, role, gross_income, super_rate, hecs_repayment_rate, pay_cycle, mortgage_contribution';

  const safeQuery = async (sql) => {
    try { return (await db.query(sql)).rows; }
    catch { return []; } // table may not exist on older databases
  };

  const backup = {
    exported_at: new Date().toISOString(),
    schema_version: 2,
    includes_credentials: withCreds,
    users: await safeQuery(`SELECT ${userCols} FROM users ORDER BY id`),
    expenses: await safeQuery('SELECT * FROM expenses ORDER BY id'),
    income_entries: await safeQuery('SELECT * FROM income_entries ORDER BY id'),
    fund_allocations: await safeQuery('SELECT * FROM fund_allocations ORDER BY id'),
    savings_goals: await safeQuery('SELECT * FROM savings_goals ORDER BY id'),
    goal_contributions: await safeQuery('SELECT * FROM goal_contributions ORDER BY id'),
    levers: await safeQuery('SELECT * FROM levers ORDER BY id'),
    account_balances: await safeQuery('SELECT * FROM account_balances ORDER BY id'),
    category_budgets: await safeQuery('SELECT * FROM category_budgets ORDER BY id'),
    category_rules: await safeQuery('SELECT * FROM category_rules ORDER BY id'),
    retention_profiles: await safeQuery('SELECT * FROM retention_profiles ORDER BY id'),
    upcoming_expenses: await safeQuery('SELECT * FROM upcoming_expenses ORDER BY id'),
    deleted_expenses: await safeQuery('SELECT * FROM deleted_expenses ORDER BY id'),
    offset_withdrawals: await safeQuery('SELECT * FROM offset_withdrawals ORDER BY id'),
    planned_withdrawals: await safeQuery('SELECT * FROM planned_withdrawals ORDER BY id'),
    weekly_checkins: await safeQuery('SELECT * FROM weekly_checkins ORDER BY id'),
  };
  res.setHeader('Content-Disposition', `attachment; filename=budget_backup_${new Date().toISOString().split('T')[0]}.json`);
  res.json(backup);
}));

// Restore from a JSON backup. Default mode 'merge' only adds rows that aren't
// already present. Mode 'replace' wipes the listed tables first — use when
// seeding a brand-new self-hosted database from an export.
app.post('/api/backup/restore', authMiddleware, asyncHandler(async (req, res) => {
  const { backup, mode } = req.body;
  if (!backup || typeof backup !== 'object') {
    return res.status(400).json({ error: 'Invalid backup data' });
  }
  const replace = mode === 'replace';
  const db = await getDb();
  const client = await db.connect();
  const counts = {};

  // Child tables first so foreign keys stay satisfied when wiping
  const WIPE_ORDER = [
    'goal_contributions', 'offset_withdrawals', 'planned_withdrawals', 'fund_allocations',
    'income_entries', 'expenses', 'account_balances', 'upcoming_expenses', 'deleted_expenses',
    'weekly_checkins', 'retention_profiles', 'category_rules', 'category_budgets',
    'savings_goals', 'levers',
  ];

  // Insert rows verbatim, preserving ids, skipping conflicts
  async function restoreTable(table, rows) {
    if (!Array.isArray(rows) || rows.length === 0) { counts[table] = 0; return; }
    // Only keep columns that actually exist in this database
    const existing = (await client.query(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]
    )).rows.map(r => r.column_name);
    if (!existing.length) { counts[table] = 0; return; }

    let inserted = 0;
    for (const row of rows) {
      const cols = Object.keys(row).filter(c => existing.includes(c) && row[c] !== undefined);
      if (!cols.length) continue;
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const values = cols.map(c => row[c]);
      const sql = `INSERT INTO ${table} (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
      try {
        const r = await client.query(sql, values);
        inserted += r.rowCount || 0;
      } catch (e) {
        // Skip rows that violate constraints rather than failing the whole restore
      }
    }
    counts[table] = inserted;

    // Move the id sequence past the restored rows
    if (existing.includes('id')) {
      try {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`
        );
      } catch (e) { /* table may not use a serial id */ }
    }
  }

  try {
    await client.query('BEGIN');

    if (replace) {
      for (const t of WIPE_ORDER) {
        try { await client.query(`DELETE FROM ${t}`); } catch (e) { /* table may not exist */ }
      }
    }

    // Users first — everything else references them
    if (Array.isArray(backup.users) && backup.users.length) {
      const existingCols = (await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'"
      )).rows.map(r => r.column_name);
      let userCount = 0;
      for (const u of backup.users) {
        const cols = Object.keys(u).filter(c => existingCols.includes(c) && u[c] !== undefined);
        if (!cols.includes('password_hash')) {
          // Backup had no credentials — keep any existing hash, else set a placeholder
          const current = (await client.query('SELECT password_hash FROM users WHERE id = $1 OR username = $2', [u.id, u.username])).rows[0];
          u.password_hash = current?.password_hash || bcrypt.hashSync('ChangeMe123', 10);
          cols.push('password_hash');
        }
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
        const updates = cols.filter(c => c !== 'id' && c !== 'username').map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
        const sql = `INSERT INTO users (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})
                     ON CONFLICT (username) DO UPDATE SET ${updates || 'username = EXCLUDED.username'}`;
        try {
          await client.query(sql, cols.map(c => u[c]));
          userCount++;
        } catch (e) { /* skip bad user row */ }
      }
      counts.users = userCount;
      try {
        await client.query("SELECT setval(pg_get_serial_sequence('users', 'id'), COALESCE((SELECT MAX(id) FROM users), 1), true)");
      } catch (e) { /* ignore */ }
    }

    // Parents before children
    const ORDER = [
      'levers', 'savings_goals', 'category_budgets', 'category_rules', 'retention_profiles',
      'expenses', 'income_entries', 'fund_allocations', 'goal_contributions',
      'account_balances', 'offset_withdrawals', 'planned_withdrawals',
      'upcoming_expenses', 'deleted_expenses', 'weekly_checkins',
    ];
    for (const table of ORDER) {
      await restoreTable(table, backup[table]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  res.json({
    message: `Restored ${total} rows across ${Object.keys(counts).length} tables`,
    mode: replace ? 'replace' : 'merge',
    counts,
  });
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

// ===================== AI ANALYSIS EXPORT =====================

app.get('/api/export/ai', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const { start, end } = req.query;
  const s = start || DATA_START_DATE;
  const e = end || new Date().toISOString().split('T')[0];

  // ── Household / config ──────────────────────────────────────────
  const users = (await db.query('SELECT display_name, gross_income, super_rate, hecs_repayment_rate, pay_cycle, mortgage_contribution FROM users ORDER BY id')).rows;
  const levers = (await db.query('SELECT name, description, value FROM levers WHERE active = 1')).rows;
  const mortgageMonthly = await getMortgageMonthly(db);
  const budgetScaleLever = levers.find(l => l.name.includes('Budget Scale'));
  const budgetScale = (budgetScaleLever?.value || 100) / 100;

  const memberProfiles = users.map(u => {
    const grossExSuper = u.gross_income / (1 + u.super_rate);
    let tax = 0;
    if (grossExSuper > 190000) tax = 51667 + (grossExSuper - 190000) * 0.45;
    else if (grossExSuper > 135000) tax = 29467 + (grossExSuper - 135000) * 0.37;
    else if (grossExSuper > 45000) tax = 5092 + (grossExSuper - 45000) * 0.325;
    else if (grossExSuper > 18200) tax = (grossExSuper - 18200) * 0.19;
    const annualNet = grossExSuper - tax - (grossExSuper * u.hecs_repayment_rate);
    return {
      name: u.display_name,
      gross_income_incl_super: u.gross_income,
      estimated_annual_net: Math.round(annualNet),
      estimated_monthly_net: Math.round(annualNet / 12),
      pay_cycle: u.pay_cycle,
      super_rate_pct: Math.round(u.super_rate * 1000) / 10,
      hecs_repayment_rate_pct: Math.round(u.hecs_repayment_rate * 1000) / 10,
      mortgage_contribution_monthly: u.mortgage_contribution,
    };
  });

  // ── Account balances ────────────────────────────────────────────
  const acctTypes = ['offset', 'savings', 'credit_card', 'investment'];
  const currentBalances = {};
  for (const acct of acctTypes) {
    const row = (await db.query('SELECT balance FROM account_balances WHERE account_type = $1 ORDER BY updated_at DESC LIMIT 1', [acct])).rows[0];
    currentBalances[acct] = row ? parseFloat(row.balance) : 0;
  }
  const offsetHistory = (await db.query(
    `SELECT DISTINCT ON (updated_at::date) updated_at::date::text as date, balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at::date, updated_at DESC`
  )).rows.map(r => ({ date: r.date, balance: parseFloat(r.balance) }));

  // ── Category budgets ────────────────────────────────────────────
  const budgetRows = (await db.query('SELECT category, monthly_amount FROM category_budgets ORDER BY category')).rows;
  const categoryBudgets = budgetRows.map(b => ({
    category: b.category,
    monthly_budget: Math.round(b.monthly_amount * budgetScale),
    is_core: !OUTLIER_CATEGORIES.includes(b.category),
  }));

  // ── Savings goals with contribution history ─────────────────────
  const goalRows = (await db.query('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;
  const goalContribRows = (await db.query(
    `SELECT gc.goal_id, gc.amount, gc.notes, ie.pay_date, u.display_name as person
     FROM goal_contributions gc
     JOIN savings_goals sg ON gc.goal_id = sg.id
     LEFT JOIN income_entries ie ON gc.income_entry_id = ie.id
     LEFT JOIN users u ON gc.user_id = u.id
     WHERE ie.pay_date >= $1 OR gc.income_entry_id IS NULL
     ORDER BY COALESCE(ie.pay_date, gc.contributed_at::date::text) ASC`,
    [s]
  )).rows;

  const savingsGoals = goalRows.map(g => ({
    name: g.name,
    target: g.target_amount,
    current: g.current_amount,
    progress_pct: g.target_amount > 0 ? Math.round((g.current_amount / g.target_amount) * 100) : null,
    priority: g.priority,
    target_date: g.target_date || null,
    contributions: goalContribRows
      .filter(c => c.goal_id === g.id)
      .map(c => ({ date: c.pay_date || null, amount: parseFloat(c.amount), person: c.person, notes: c.notes })),
  }));

  // ── Income entries with goal allocations ────────────────────────
  const incomeRows = (await db.query(
    `SELECT ie.id, ie.pay_date, u.display_name as person, ie.pay_type, ie.amount, ie.net_amount,
            ie.offset_transfer, ie.retention_amount, ie.mortgage_contribution, ie.is_surplus, ie.notes
     FROM income_entries ie JOIN users u ON ie.user_id = u.id
     WHERE ie.pay_date >= $1 AND ie.pay_date <= $2
     ORDER BY ie.pay_date ASC`,
    [s, e]
  )).rows;

  const goalContribByIncome = (await db.query(
    `SELECT gc.income_entry_id, sg.name as goal_name, gc.amount
     FROM goal_contributions gc JOIN savings_goals sg ON gc.goal_id = sg.id
     WHERE gc.income_entry_id IS NOT NULL`
  )).rows;

  const incomeEntries = incomeRows.map(i => ({
    date: i.pay_date,
    person: i.person,
    type: i.pay_type,
    is_surplus_entry: !!i.is_surplus,
    gross_amount: parseFloat(i.amount),
    net_amount: parseFloat(i.net_amount || i.amount),
    offset_transfer: parseFloat(i.offset_transfer || 0),
    retention_kept: parseFloat(i.retention_amount || 0),
    mortgage_contribution: parseFloat(i.mortgage_contribution || 0),
    notes: i.notes || null,
    goal_allocations: goalContribByIncome
      .filter(g => g.income_entry_id === i.id)
      .map(g => ({ goal: g.goal_name, amount: parseFloat(g.amount) })),
  }));

  // ── Expenses ────────────────────────────────────────────────────
  const expenseRows = (await db.query(
    `SELECT e.expense_date, u.display_name as person, e.category, e.subcategory,
            e.description, e.amount, e.entry_type
     FROM expenses e JOIN users u ON e.user_id = u.id
     WHERE e.expense_date >= $1 AND e.expense_date <= $2
     ORDER BY e.expense_date ASC`,
    [s, e]
  )).rows;

  const expenses = expenseRows.map(r => ({
    date: r.expense_date,
    person: r.person,
    category: r.category,
    subcategory: r.subcategory || null,
    description: r.description,
    amount: parseFloat(r.amount),
    is_core: !OUTLIER_CATEGORIES.includes(r.category),
    type: r.entry_type,
  }));

  // ── Upcoming expenses ───────────────────────────────────────────
  const upcomingRows = (await db.query(
    `SELECT ue.description, ue.estimated_amount, ue.expected_date, ue.category, ue.notes, u.display_name as person
     FROM upcoming_expenses ue JOIN users u ON ue.user_id = u.id
     WHERE ue.resolved = 0 ORDER BY ue.expected_date ASC`
  )).rows;
  const upcomingExpenses = upcomingRows.map(r => ({
    description: r.description,
    estimated_amount: parseFloat(r.estimated_amount),
    expected_date: r.expected_date,
    category: r.category || null,
    person: r.person,
    notes: r.notes || null,
  }));

  // ── Monthly summaries ───────────────────────────────────────────
  const monthlyCatRows = (await db.query(
    `SELECT TO_CHAR(expense_date::date, 'YYYY-MM') as month, category, SUM(amount) as total
     FROM expenses WHERE expense_date >= $1 AND expense_date <= $2
     GROUP BY month, category ORDER BY month, total DESC`,
    [s, e]
  )).rows;

  const monthlyIncomeRows = (await db.query(
    `SELECT TO_CHAR(pay_date::date, 'YYYY-MM') as month,
            SUM(net_amount) as total_net,
            SUM(COALESCE(offset_transfer, 0)) as total_offset,
            SUM(COALESCE(retention_amount, 0)) as total_retained
     FROM income_entries WHERE pay_date >= $1 AND pay_date <= $2
     GROUP BY month ORDER BY month`,
    [s, e]
  )).rows;

  const allMonths = [...new Set([
    ...monthlyCatRows.map(r => r.month),
    ...monthlyIncomeRows.map(r => r.month),
  ])].sort();

  const monthlySummaries = allMonths.map(month => {
    const catRows = monthlyCatRows.filter(r => r.month === month);
    const byCategory = {};
    let total = 0;
    let core = 0;
    for (const r of catRows) {
      byCategory[r.category] = Math.round(parseFloat(r.total));
      total += parseFloat(r.total);
      if (!OUTLIER_CATEGORIES.includes(r.category)) core += parseFloat(r.total);
    }
    const incRow = monthlyIncomeRows.find(r => r.month === month);
    return {
      month,
      total_spending: Math.round(total),
      core_spending: Math.round(core),
      outlier_spending: Math.round(total - core),
      income_received: Math.round(parseFloat(incRow?.total_net || 0)),
      offset_transfers: Math.round(parseFloat(incRow?.total_offset || 0)),
      retention_kept: Math.round(parseFloat(incRow?.total_retained || 0)),
      spending_by_category: byCategory,
    };
  });

  // ── Key computed metrics ────────────────────────────────────────
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const totalSpent30d = (await db.query('SELECT SUM(amount) as t FROM expenses WHERE expense_date >= $1', [thirtyDaysAgo])).rows[0];
  const coreSpent30d = (await db.query('SELECT SUM(amount) as t FROM expenses WHERE expense_date >= $1 AND NOT (category = ANY($2))', [thirtyDaysAgo, OUTLIER_CATEGORIES])).rows[0];
  const offsetBal = currentBalances.offset || 0;
  const mortgageRateVal = await getMortgageRate(db);
  const annualInterestSaved = offsetBal * mortgageRateVal;
  const totalMonthlyBudget = budgetRows.reduce((s, b) => s + b.monthly_amount * budgetScale, 0);
  const coreMonthlyBudget = budgetRows.filter(b => !OUTLIER_CATEGORIES.includes(b.category)).reduce((s, b) => s + b.monthly_amount * budgetScale, 0);
  const totalMonthlyNetIncome = memberProfiles.reduce((s, u) => s + u.estimated_monthly_net, 0);

  const payload = {
    export_metadata: {
      exported_at: new Date().toISOString(),
      date_range: { start: s, end: e },
      currency: 'AUD',
      app: 'Household Budget Tracker',
    },
    analysis_context: {
      summary: `Household budget data for Adam and Aruto in Sydney, Australia. All surplus income flows to an offset account linked to their mortgage to reduce interest. The offset balance earns effective interest at the mortgage rate (${(mortgageRateVal * 100).toFixed(2)}%) rather than a savings account.`,
      core_spending_note: `"Core" spending excludes [${OUTLIER_CATEGORIES.join(', ')}] — these are lumpy, infrequent or fixed obligations. Core spending reflects day-to-day discretionary habits.`,
      offset_strategy: 'Each payday, net pay minus retention (spending money kept) is transferred to the offset account. Mortgage is auto-debited from offset on the 23rd each month.',
      key_metrics: {
        total_spending_last_30d: Math.round(parseFloat(totalSpent30d.t) || 0),
        core_spending_last_30d: Math.round(parseFloat(coreSpent30d.t) || 0),
        avg_daily_core_spend_30d: Math.round((parseFloat(coreSpent30d.t) || 0) / 30),
        total_monthly_budget: Math.round(totalMonthlyBudget),
        core_monthly_budget: Math.round(coreMonthlyBudget),
        estimated_monthly_net_income: Math.round(totalMonthlyNetIncome),
        estimated_monthly_surplus: Math.round(totalMonthlyNetIncome - (parseFloat(totalSpent30d.t) || 0)),
        mortgage_monthly: mortgageMonthly,
        mortgage_rate_pct: mortgageRateVal * 100,
        offset_balance: offsetBal,
        offset_interest_saved_annually: Math.round(annualInterestSaved),
        offset_interest_saved_monthly: Math.round(annualInterestSaved / 12),
      },
      questions_you_can_ask: [
        'How is our spending trending month over month?',
        'Which categories are we consistently over/under budget on?',
        'At current pace, when will each savings goal be reached?',
        'How much are we saving vs how much could we save?',
        'What would happen to our offset balance if we cut dining out by 30%?',
        'Are there any unusual spending spikes worth investigating?',
        'How does our actual spending compare to our income?',
        'What is our effective savings rate?',
      ],
    },
    household: {
      members: memberProfiles,
      mortgage_monthly_total: mortgageMonthly,
      mortgage_rate_pct: mortgageRateVal * 100,
      budget_scale_pct: Math.round(budgetScale * 100),
      levers: levers.map(l => ({ name: l.name, value: l.value, description: l.description })),
    },
    current_balances: currentBalances,
    offset_balance_history: offsetHistory,
    category_budgets: categoryBudgets,
    savings_goals: savingsGoals,
    income_entries: incomeEntries,
    expenses,
    upcoming_expenses: upcomingExpenses,
    monthly_summaries: monthlySummaries,
  };

  res.setHeader('Content-Disposition', `attachment; filename=budget_ai_${e}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(payload, null, 2));
}));

// ===================== MORTGAGE CONFIG =====================

app.get('/api/mortgage-config', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const config = await getMortgageConfig(db);
  res.json(config);
}));

app.put('/api/mortgage-config', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const { rate, monthly_payment, start_date, term_years } = req.body;
  const userId = req.user.id;

  const upsert = async (name, value, description, leverType) => {
    const existing = (await db.query("SELECT id FROM levers WHERE name = $1 AND active = 1", [name])).rows[0];
    if (existing) {
      await db.query("UPDATE levers SET value = $1, set_by = $2, updated_at = NOW() WHERE id = $3", [value, userId, existing.id]);
    } else {
      await db.query("INSERT INTO levers (name, description, lever_type, value, set_by) VALUES ($1, $2, $3, $4, $5)", [name, description, leverType, value, userId]);
    }
  };

  if (rate !== undefined) await upsert('Mortgage Rate', rate, 'Annual mortgage interest rate (variable)', 'percentage');
  if (monthly_payment !== undefined) await upsert('Mortgage Monthly', monthly_payment, 'Total monthly mortgage payment (auto-debited from offset on 23rd)', 'dollar');
  if (start_date !== undefined) await upsert('Mortgage Start Date', start_date, 'Date of first mortgage payment', 'text');
  if (term_years !== undefined) await upsert('Mortgage Term Years', term_years, 'Original mortgage term in years', 'number');

  const config = await getMortgageConfig(db);
  res.json(config);
}));

// ===================== PROJECTIONS =====================

app.get('/api/projections', authMiddleware, asyncHandler(async (req, res) => {
  const db = await getDb();
  const users = (await db.query('SELECT * FROM users')).rows;
  const mc = await getMortgageConfig(db);

  const paceDays = Math.min(Math.max(parseInt(req.query.pace_days) || 30, 7), 365);
  const projectionMonths = Math.min(Math.max(parseInt(req.query.months) || 24, 3), 360);
  const paceStart = clampDate(new Date(Date.now() - paceDays * 86400000).toISOString().split('T')[0]);
  const thirtyDaysAgo = clampDate(new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]);

  const paceExpenses = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1', [paceStart])).rows[0];
  const monthlyExpenses = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1', [thirtyDaysAgo])).rows[0];

  const actualDaysElapsed = Math.max(1, Math.floor((Date.now() - new Date(paceStart + 'T00:00:00').getTime()) / 86400000));
  const dailySpendRate = (parseFloat(paceExpenses.total) || 0) / actualDaysElapsed;
  const monthlyExpenseAtPace = dailySpendRate * 30.44;

  let totalAnnualNet = 0;
  for (const u of users) {
    const grossExSuper = u.gross_income / (1 + u.super_rate);
    let tax = 0;
    if (grossExSuper > 190000) tax = 51667 + (grossExSuper - 190000) * 0.45;
    else if (grossExSuper > 135000) tax = 29467 + (grossExSuper - 135000) * 0.37;
    else if (grossExSuper > 45000) tax = 5092 + (grossExSuper - 45000) * 0.325;
    else if (grossExSuper > 18200) tax = (grossExSuper - 18200) * 0.19;
    totalAnnualNet += grossExSuper - tax - (grossExSuper * u.hecs_repayment_rate);
  }

  const monthlyNetIncome = totalAnnualNet / 12;
  const estimatedSurplus = monthlyNetIncome - monthlyExpenseAtPace;

  const offsetRow = (await db.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
  const offsetBalance = offsetRow ? parseFloat(offsetRow.balance) : 0;

  const goals = (await db.query('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;
  const levers = (await db.query('SELECT * FROM levers WHERE active = 1')).rows;
  const budgets = (await db.query('SELECT * FROM category_budgets')).rows;
  const budgetScale = (levers.find(l => l.name.includes('Budget Scale'))?.value || 100) / 100;
  const totalMonthlyBudget = budgets.reduce((sum, b) => sum + b.monthly_amount * budgetScale, 0);
  const budgetedSurplus = monthlyNetIncome - totalMonthlyBudget;

  // ── What actually landed in the offset, measured rather than estimated ──
  // This is the honest number: real pay transfers in, real withdrawals out.
  const sixMonthsAgo = clampDate(new Date(Date.now() - 182 * 86400000).toISOString().split('T')[0]);
  const actualIn6mo = parseFloat((await db.query(
    'SELECT SUM(COALESCE(offset_transfer, 0)) as total FROM income_entries WHERE pay_date >= $1', [sixMonthsAgo]
  )).rows[0]?.total) || 0;
  const actualWithdrawn6mo = parseFloat((await db.query(
    'SELECT SUM(amount) as total FROM offset_withdrawals WHERE withdrawal_date >= $1', [sixMonthsAgo]
  )).rows[0]?.total) || 0;
  const firstPay = (await db.query(
    'SELECT MIN(pay_date) as d FROM income_entries WHERE pay_date >= $1 AND COALESCE(offset_transfer, 0) > 0', [sixMonthsAgo]
  )).rows[0]?.d;
  // pay_date is TEXT and may arrive as 'YYYY-MM-DD' or a full timestamp — take the date part only
  const firstPayDay = firstPay ? String(firstPay).slice(0, 10) : null;
  const firstPayMs = firstPayDay ? new Date(firstPayDay + 'T00:00:00Z').getTime() : NaN;
  const observedMonths = Number.isFinite(firstPayMs)
    ? Math.max(1, (Date.now() - firstPayMs) / (86400000 * 30.44))
    : 1;
  // Gross into offset per month, before the mortgage debit leaves again
  const actualMonthlyIn = actualIn6mo / observedMonths;
  const actualMonthlyWithdrawn = actualWithdrawn6mo / observedMonths;
  const actualSurplus = actualMonthlyIn - actualMonthlyWithdrawn;

  // Which basis drives the projection: measured (default), estimated, or budget
  const requestedBasis = ['actual', 'estimated', 'budget'].includes(req.query.basis) ? req.query.basis : 'actual';
  const haveActuals = actualIn6mo > 0;
  // Without real pay data the measured basis is meaningless, so fall back and say so
  const basis = (requestedBasis === 'actual' && !haveActuals) ? 'estimated' : requestedBasis;
  const basisFellBack = basis !== requestedBasis;
  const monthlySurplus = basis === 'estimated' ? estimatedSurplus
    : basis === 'budget' ? budgetedSurplus
    : actualSurplus;

  // Future one-off and recurring withdrawals the user has told us about
  const plannedWithdrawals = (await db.query(
    'SELECT * FROM planned_withdrawals WHERE active = 1'
  )).rows.map(p => ({
    ...p,
    amount: parseFloat(p.amount),
    recurring: !!p.recurring,
    frequency_months: parseInt(p.frequency_months) || 0,
  }));

  // Map planned withdrawals onto month offsets from now
  function plannedWithdrawalForMonth(monthOffset, monthDate) {
    let total = 0;
    for (const p of plannedWithdrawals) {
      if (p.recurring && p.frequency_months > 0) {
        if (monthOffset > 0 && monthOffset % p.frequency_months === 0) total += p.amount;
      } else if (p.target_date) {
        const t = new Date(p.target_date + 'T00:00:00');
        if (t.getFullYear() === monthDate.getFullYear() && t.getMonth() === monthDate.getMonth()) total += p.amount;
      }
    }
    return total;
  }

  // ── Mortgage amortization calculations ──
  const now = new Date();
  const mortgageStart = new Date(mc.startDate + 'T00:00:00');
  const monthsElapsed = (now.getFullYear() - mortgageStart.getFullYear()) * 12 + (now.getMonth() - mortgageStart.getMonth());
  const originalPayoffDate = new Date(mortgageStart);
  originalPayoffDate.setMonth(originalPayoffDate.getMonth() + mc.termMonths);

  // Standard amortization (no offset) — compute remaining balance and total interest
  let balanceNoOffset = mc.principal;
  let totalInterestNoOffset = 0;
  for (let m = 0; m < mc.termMonths && balanceNoOffset > 0; m++) {
    const interest = balanceNoOffset * mc.monthlyRate;
    totalInterestNoOffset += interest;
    const principalPaid = Math.min(mc.monthlyPayment - interest, balanceNoOffset);
    balanceNoOffset -= principalPaid;
  }
  const totalCostNoOffset = mc.principal + totalInterestNoOffset;

  // Amortization WITH offset — project forward from current state
  // First reconstruct current mortgage balance (standard amortization for months elapsed)
  let currentMortgageBalance = mc.principal;
  let interestPaidSoFar = 0;
  for (let m = 0; m < monthsElapsed && currentMortgageBalance > 0; m++) {
    const interest = currentMortgageBalance * mc.monthlyRate;
    interestPaidSoFar += interest;
    const principalPaid = Math.min(mc.monthlyPayment - interest, currentMortgageBalance);
    currentMortgageBalance -= principalPaid;
  }

  // Now project forward WITH offset growing
  const netOffsetGrowth = Math.max(0, monthlySurplus) - mc.monthlyPayment;
  let projBalance = currentMortgageBalance;
  let projOffset = offsetBalance;
  let totalInterestWithOffset = interestPaidSoFar;
  let payoffMonth = null;
  const projections = [];
  const amortWithOffset = [];
  const amortWithoutOffset = [];
  let balNoOff = currentMortgageBalance;

  for (let m = 1; m <= Math.max(projectionMonths, mc.termMonths - monthsElapsed); m++) {
    const date = new Date();
    date.setMonth(date.getMonth() + m);
    const monthLabel = date.toISOString().substring(0, 7);

    // Without offset path
    if (balNoOff > 0) {
      const intNoOff = balNoOff * mc.monthlyRate;
      const princNoOff = Math.min(mc.monthlyPayment - intNoOff, balNoOff);
      balNoOff = Math.max(0, balNoOff - princNoOff);
    }

    // Planned spending out of the offset lands in the month it's due
    const planned = plannedWithdrawalForMonth(m, date);

    // With offset path — surplus flows in, mortgage payment flows out
    if (projBalance > 0) {
      const effectiveBalance = Math.max(0, projBalance - projOffset);
      const interest = effectiveBalance * mc.monthlyRate;
      totalInterestWithOffset += interest;
      const principalPaid = Math.min(mc.monthlyPayment - interest, projBalance);
      projBalance = Math.max(0, projBalance - principalPaid);
      projOffset = Math.max(0, projOffset + monthlySurplus - mc.monthlyPayment - planned);
      if (projBalance <= 0 && !payoffMonth) payoffMonth = m;
    } else {
      // Mortgage gone: the payment stays in your pocket, planned spending still applies
      projOffset = Math.max(0, projOffset + monthlySurplus - planned);
    }

    if (m <= projectionMonths) {
      projections.push({
        month: monthLabel,
        offset: Math.round(projOffset),
        mortgage_remaining: Math.round(projBalance),
        mortgage_no_offset: Math.round(balNoOff),
        planned_withdrawal: Math.round(planned),
        interest_saved_monthly: Math.round(Math.max(0, projBalance * mc.monthlyRate - Math.max(0, projBalance - projOffset) * mc.monthlyRate)),
        net_growth: Math.round(netOffsetGrowth),
      });
    }

    if (m <= 360) {
      amortWithOffset.push({ month: monthLabel, balance: Math.round(projBalance), offset: Math.round(projOffset) });
      amortWithoutOffset.push({ month: monthLabel, balance: Math.round(balNoOff) });
    }
  }

  const totalInterestSaved = totalInterestNoOffset - totalInterestWithOffset;
  const projectedPayoffDate = payoffMonth
    ? new Date(new Date().setMonth(new Date().getMonth() + payoffMonth))
    : originalPayoffDate;
  const timeSavedMonths = payoffMonth
    ? Math.max(0, (mc.termMonths - monthsElapsed) - payoffMonth)
    : 0;
  const timeSavedYears = Math.floor(timeSavedMonths / 12);
  const timeSavedRemMonths = timeSavedMonths % 12;

  // ── Savings rate from actual data ──
  const threeMonthsAgo = clampDate(new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]);
  const recentIncome = (await db.query('SELECT SUM(offset_transfer) as total FROM income_entries WHERE pay_date >= $1', [threeMonthsAgo])).rows[0];
  const recentMortgageDebits = (await db.query("SELECT COUNT(*) as cnt FROM fund_allocations WHERE notes LIKE 'Mortgage%' AND allocated_date >= $1", [threeMonthsAgo])).rows[0];
  const mortgageDebitsInPeriod = parseInt(recentMortgageDebits.cnt) || 0;
  const totalAddedToOffset = parseFloat(recentIncome.total) || 0;
  const totalDebitedFromOffset = mortgageDebitsInPeriod * mc.monthlyPayment;
  const netSavingsRate3mo = (totalAddedToOffset - totalDebitedFromOffset) / 3;

  // ── Spending scenarios ──
  const scenarios = [
    { label: 'Cut spending 10%', monthly_saving: Math.round(monthlyExpenseAtPace * 0.10) },
    { label: 'Cut spending 20%', monthly_saving: Math.round(monthlyExpenseAtPace * 0.20) },
    { label: 'Save extra $500/mo', monthly_saving: 500 },
    { label: 'Save extra $1,000/mo', monthly_saving: 1000 },
    { label: 'Save extra $2,000/mo', monthly_saving: 2000 },
  ].map(s => {
    let bal = currentMortgageBalance;
    let off = offsetBalance;
    let totalInt = interestPaidSoFar;
    let pm = null;
    const adjustedSurplus = monthlySurplus + s.monthly_saving;
    for (let m = 1; m <= mc.termMonths && bal > 0; m++) {
      const eff = Math.max(0, bal - off);
      const interest = eff * mc.monthlyRate;
      totalInt += interest;
      const princPaid = Math.min(mc.monthlyPayment - interest, bal);
      bal = Math.max(0, bal - princPaid);
      off = Math.max(0, off + adjustedSurplus - mc.monthlyPayment);
      if (bal <= 0 && !pm) pm = m;
    }
    const intSaved = totalInterestNoOffset - totalInt;
    const tSaved = pm ? Math.max(0, (mc.termMonths - monthsElapsed) - pm) : 0;
    return {
      ...s,
      payoff_months: pm || (mc.termMonths - monthsElapsed),
      time_saved_months: tSaved,
      time_saved_years: Math.floor(tSaved / 12),
      time_saved_rem_months: tSaved % 12,
      interest_saved: Math.round(intSaved),
    };
  });

  // Milestones
  const milestones = {};
  [12, 24, 36, 60].forEach(m => {
    if (m <= projectionMonths && projections[m - 1]) {
      milestones[`${m}mo`] = projections[m - 1].offset;
    }
  });

  // ── Spending & saving patterns: what the data actually says ──
  const twelveMonthsAgo = clampDate(new Date(Date.now() - 365 * 86400000).toISOString().split('T')[0]);

  const monthlyHistory = (await db.query(
    `SELECT to_char(expense_date::date, 'YYYY-MM') as month,
            SUM(amount) as total,
            SUM(CASE WHEN NOT (category = ANY($2)) THEN amount ELSE 0 END) as core_total,
            COUNT(*) as txns
     FROM expenses
     WHERE expense_date >= $1 AND NOT (category = ANY($3))
     GROUP BY 1 ORDER BY 1`,
    [twelveMonthsAgo, OUTLIER_CATEGORIES, NON_SPENDING_CATEGORIES]
  )).rows.map(r => ({
    month: r.month,
    total: Math.round(parseFloat(r.total)),
    core_total: Math.round(parseFloat(r.core_total)),
    txns: parseInt(r.txns),
  }));

  // Only compare whole months — the current partial month would look artificially low
  const currentMonthKey = new Date().toISOString().substring(0, 7);
  const completeMonths = monthlyHistory.filter(m => m.month !== currentMonthKey);
  const avgMonthlySpend = completeMonths.length
    ? completeMonths.reduce((s, m) => s + m.total, 0) / completeMonths.length : 0;
  const last3 = completeMonths.slice(-3);
  const prev3 = completeMonths.slice(-6, -3);
  const avgLast3 = last3.length ? last3.reduce((s, m) => s + m.total, 0) / last3.length : 0;
  const avgPrev3 = prev3.length ? prev3.reduce((s, m) => s + m.total, 0) / prev3.length : 0;
  const spendTrendPct = avgPrev3 > 0 ? Math.round(((avgLast3 - avgPrev3) / avgPrev3) * 100) : 0;

  // Category movers: last 90 days vs the 90 before that
  const ninetyStart = clampDate(new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]);
  const oneEightyStart = clampDate(new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0]);
  const recentByCat = (await db.query(
    `SELECT category, SUM(amount) as total FROM expenses
     WHERE expense_date >= $1 AND NOT (category = ANY($2)) GROUP BY category`,
    [ninetyStart, NON_SPENDING_CATEGORIES]
  )).rows;
  const priorByCat = (await db.query(
    `SELECT category, SUM(amount) as total FROM expenses
     WHERE expense_date >= $1 AND expense_date < $2 AND NOT (category = ANY($3)) GROUP BY category`,
    [oneEightyStart, ninetyStart, NON_SPENDING_CATEGORIES]
  )).rows;
  const priorMap = Object.fromEntries(priorByCat.map(r => [r.category, parseFloat(r.total)]));
  const categoryMovers = recentByCat.map(r => {
    const now3 = parseFloat(r.total) / 3;
    const then3 = (priorMap[r.category] || 0) / 3;
    return {
      category: r.category,
      monthly_now: Math.round(now3),
      monthly_before: Math.round(then3),
      change: Math.round(now3 - then3),
      change_pct: then3 > 0 ? Math.round(((now3 - then3) / then3) * 100) : null,
    };
  }).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 8);

  // Likely recurring commitments — same merchant, similar amount, 3+ times
  const recurring = (await db.query(
    `SELECT description, category, COUNT(*) as hits, AVG(amount) as avg_amount,
            STDDEV_POP(amount) as spread, MAX(expense_date) as last_seen
     FROM expenses
     WHERE expense_date >= $1 AND description IS NOT NULL AND description <> ''
       AND NOT (category = ANY($2))
     GROUP BY description, category
     HAVING COUNT(*) >= 3 AND AVG(amount) > 5
     ORDER BY AVG(amount) * COUNT(*) DESC LIMIT 15`,
    [twelveMonthsAgo, NON_SPENDING_CATEGORIES]
  )).rows
    .filter(r => {
      const avg = parseFloat(r.avg_amount);
      const spread = parseFloat(r.spread) || 0;
      return avg > 0 && spread / avg < 0.15; // consistent amount => subscription-like
    })
    .map(r => ({
      description: r.description,
      category: r.category,
      hits: parseInt(r.hits),
      avg_amount: Math.round(parseFloat(r.avg_amount) * 100) / 100,
      last_seen: r.last_seen,
    }));
  const recurringMonthly = recurring.reduce((s, r) => s + r.avg_amount, 0);

  // Weekday vs weekend habit split
  const dayRows = (await db.query(
    `SELECT EXTRACT(DOW FROM expense_date::date) as dow, SUM(amount) as total, COUNT(*) as cnt
     FROM expenses WHERE expense_date >= $1 AND NOT (category = ANY($2)) GROUP BY 1`,
    [ninetyStart, NON_SPENDING_CATEGORIES]
  )).rows;
  const weekendSpend = dayRows.filter(r => [0, 6].includes(parseInt(r.dow))).reduce((s, r) => s + parseFloat(r.total), 0);
  const weekdaySpend = dayRows.filter(r => ![0, 6].includes(parseInt(r.dow))).reduce((s, r) => s + parseFloat(r.total), 0);
  const totalDaySpend = weekendSpend + weekdaySpend;

  // Saving consistency: how much actually hit the offset each month
  const savingHistory = (await db.query(
    `SELECT to_char(pay_date::date, 'YYYY-MM') as month, SUM(COALESCE(offset_transfer, 0)) as total
     FROM income_entries WHERE pay_date >= $1 GROUP BY 1 ORDER BY 1`,
    [twelveMonthsAgo]
  )).rows.map(r => ({ month: r.month, total: Math.round(parseFloat(r.total)) }));
  const completeSaving = savingHistory.filter(m => m.month !== currentMonthKey);
  const avgSaved = completeSaving.length ? completeSaving.reduce((s, m) => s + m.total, 0) / completeSaving.length : 0;
  const savingVariance = completeSaving.length > 1
    ? Math.sqrt(completeSaving.reduce((s, m) => s + Math.pow(m.total - avgSaved, 2), 0) / completeSaving.length)
    : 0;

  const patterns = {
    monthly_history: monthlyHistory,
    avg_monthly_spend: Math.round(avgMonthlySpend),
    avg_last_3mo: Math.round(avgLast3),
    avg_prev_3mo: Math.round(avgPrev3),
    spend_trend_pct: spendTrendPct,
    spend_direction: spendTrendPct > 5 ? 'rising' : spendTrendPct < -5 ? 'falling' : 'steady',
    category_movers: categoryMovers,
    recurring_commitments: recurring,
    recurring_monthly_total: Math.round(recurringMonthly),
    weekend_share_pct: totalDaySpend > 0 ? Math.round((weekendSpend / totalDaySpend) * 100) : 0,
    saving_history: savingHistory,
    avg_monthly_saved: Math.round(avgSaved),
    saving_consistency: avgSaved > 0
      ? (savingVariance / avgSaved < 0.15 ? 'very consistent'
        : savingVariance / avgSaved < 0.35 ? 'fairly consistent' : 'variable')
      : 'no data',
    months_of_expenses_in_offset: avgMonthlySpend > 0
      ? Math.round((offsetBalance / avgMonthlySpend) * 10) / 10 : null,
  };

  // Goal achievement forecast — share the real surplus by priority weighting
  const activeGoals = goals.filter(g => (g.target_amount || 0) > (g.current_amount || 0));
  const priorityWeights = activeGoals.map(g => 1 / Math.max(1, g.priority || 5));
  const weightSum = priorityWeights.reduce((s, w) => s + w, 0) || 1;
  const goalForecasts = goals.map(g => {
    const remaining = Math.max(0, (g.target_amount || 0) - (g.current_amount || 0));
    const idx = activeGoals.findIndex(a => a.id === g.id);
    const share = idx >= 0 ? priorityWeights[idx] / weightSum : 0;
    const monthlyContrib = Math.max(0, monthlySurplus) * share;
    const monthsToGoal = remaining <= 0 ? 0 : (monthlyContrib > 0 ? Math.ceil(remaining / monthlyContrib) : null);
    const eta = monthsToGoal !== null && monthsToGoal > 0
      ? new Date(new Date().setMonth(new Date().getMonth() + monthsToGoal)).toISOString().split('T')[0]
      : null;
    return {
      ...g,
      remaining: Math.round(remaining),
      monthly_contribution: Math.round(monthlyContrib),
      months_to_goal: monthsToGoal,
      eta,
    };
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
  const rateDisplay = (mc.rate * 100).toFixed(2);
  const message = monthlySurplus > 500
    ? `You're adding ~$${Math.round(monthlySurplus)}/month to offset. Every dollar saves ${rateDisplay}% in mortgage interest!`
    : monthlySurplus > 0
    ? `Positive surplus of ~$${Math.round(monthlySurplus)}/month going to offset. Look for ways to grow it.`
    : `Warning: spending exceeds income by ~$${Math.round(Math.abs(monthlySurplus))}/month. Offset balance will shrink.`;

  res.json({
    monthly_net_income: Math.round(monthlyNetIncome),
    monthly_expenses: Math.round(parseFloat(monthlyExpenses.total) || 0),
    monthly_expenses_at_pace: Math.round(monthlyExpenseAtPace),
    pace_days: paceDays,
    daily_spend_rate: Math.round(dailySpendRate),
    mortgage: mc.monthlyPayment,
    mortgage_config: {
      rate_percent: mc.ratePercent,
      monthly_payment: mc.monthlyPayment,
      start_date: mc.startDate,
      term_years: mc.termYears,
      original_principal: Math.round(mc.principal),
      current_balance: Math.round(currentMortgageBalance),
      months_elapsed: monthsElapsed,
      original_payoff_date: originalPayoffDate.toISOString().split('T')[0],
      projected_payoff_date: projectedPayoffDate.toISOString().split('T')[0],
      time_saved_years: timeSavedYears,
      time_saved_months: timeSavedRemMonths,
      total_time_saved_months: timeSavedMonths,
      total_interest_no_offset: Math.round(totalInterestNoOffset),
      total_interest_with_offset: Math.round(totalInterestWithOffset),
      total_interest_saved: Math.round(totalInterestSaved),
      interest_saved_monthly_now: Math.round(Math.max(0, currentMortgageBalance - Math.max(0, currentMortgageBalance - offsetBalance)) * mc.monthlyRate),
    },
    monthly_surplus: Math.round(monthlySurplus),
    budgeted_expenses: Math.round(totalMonthlyBudget),
    budgeted_surplus: Math.round(budgetedSurplus),
    net_offset_growth: Math.round(Math.max(0, monthlySurplus) - mc.monthlyPayment),
    savings_rate: {
      monthly_net: Math.round(netSavingsRate3mo),
      total_added_3mo: Math.round(totalAddedToOffset),
      total_debited_3mo: Math.round(totalDebitedFromOffset),
    },
    // Which number drives the projection, and what the alternatives would be
    basis,
    requested_basis: requestedBasis,
    basis_fell_back: basisFellBack,
    basis_options: {
      actual: haveActuals ? Math.round(actualSurplus) : null,
      estimated: Math.round(estimatedSurplus),
      budget: Math.round(budgetedSurplus),
    },
    basis_detail: {
      have_actuals: haveActuals,
      observed_months: Math.round(observedMonths * 10) / 10,
      actual_monthly_in: Math.round(actualMonthlyIn),
      actual_monthly_withdrawn: Math.round(actualMonthlyWithdrawn),
    },
    planned_withdrawals: plannedWithdrawals,
    planned_withdrawals_total: Math.round(plannedWithdrawals.reduce((s, p) => s + p.amount, 0)),
    patterns,
    projections,
    projection_months: projectionMonths,
    milestones,
    offset_balance: offsetBalance,
    goals: goalForecasts,
    scenarios,
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
