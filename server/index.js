require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const XLSX = require('xlsx');
const { getDb, autoCategorizeTxn } = require('./db');
const { generateToken, authMiddleware } = require('./auth');
const { getPayDayAdvice, getNightlySummary, getAccountSweepAdvice, extractTransactionsFromImage } = require('./claude');

const app = express();
const PORT = process.env.PORT || 4000;

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

app.post('/api/auth/login', async (req, res) => {
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
});

app.post('/api/auth/register', async (req, res) => {
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
});

app.put('/api/auth/profile', authMiddleware, async (req, res) => {
  const { display_name, gross_income, super_rate, hecs_repayment_rate, pay_cycle } = req.body;
  const db = await getDb();
  await db.query(
    'UPDATE users SET display_name = COALESCE($1, display_name), gross_income = COALESCE($2, gross_income), super_rate = COALESCE($3, super_rate), hecs_repayment_rate = COALESCE($4, hecs_repayment_rate), pay_cycle = COALESCE($5, pay_cycle) WHERE id = $6',
    [display_name, gross_income, super_rate, hecs_repayment_rate, pay_cycle, req.user.id]
  );
  const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
  res.json({ id: user.id, username: user.username, display_name: user.display_name, role: user.role, gross_income: user.gross_income, super_rate: user.super_rate, hecs_repayment_rate: user.hecs_repayment_rate, pay_cycle: user.pay_cycle });
});

app.put('/api/auth/password', authMiddleware, async (req, res) => {
  const { current_password, new_password } = req.body;
  const db = await getDb();
  const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
  res.json({ message: 'Password updated' });
});

// ===================== EXPENSE ROUTES =====================

app.get('/api/expenses', authMiddleware, async (req, res) => {
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
});

app.post('/api/expenses', authMiddleware, async (req, res) => {
  const { category, subcategory, description, amount, expense_date, entry_type, is_range, range_low, range_high, recurring } = req.body;
  const db = await getDb();
  const result = await db.query(
    'INSERT INTO expenses (user_id, category, subcategory, description, amount, expense_date, entry_type, is_range, range_low, range_high, recurring) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
    [req.user.id, category, subcategory || null, description || null, amount, expense_date, entry_type || 'actual', is_range ? 1 : 0, range_low || null, range_high || null, recurring ? 1 : 0]
  );
  const expense = (await db.query('SELECT e.*, u.display_name as user_name FROM expenses e JOIN users u ON e.user_id = u.id WHERE e.id = $1', [result.rows[0].id])).rows[0];
  res.json(expense);
});

app.post('/api/expenses/batch', authMiddleware, async (req, res) => {
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
});

app.delete('/api/expenses/:id', authMiddleware, async (req, res) => {
  const db = await getDb();
  // Record deletion for persistent memory (prevent re-import)
  const expense = (await db.query('SELECT * FROM expenses WHERE id = $1', [req.params.id])).rows[0];
  if (expense) {
    await db.query(
      'INSERT INTO deleted_expenses (description, amount, expense_date, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [expense.description, expense.amount, expense.expense_date, expense.user_id]
    );
  }
  await db.query('DELETE FROM expenses WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ message: 'Deleted' });
});

// Update expense (for speed-run categorisation etc.)
app.put('/api/expenses/:id', authMiddleware, async (req, res) => {
  const { category, description, amount } = req.body;
  const db = await getDb();
  const updates = [];
  const params = [];
  let paramIdx = 1;
  if (category) { updates.push(`category = $${paramIdx++}`); params.push(category); }
  if (description !== undefined) { updates.push(`description = $${paramIdx++}`); params.push(description); }
  if (amount !== undefined) { updates.push(`amount = $${paramIdx++}`); params.push(amount); }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  await db.query(`UPDATE expenses SET ${updates.join(', ')} WHERE id = $${paramIdx}`, params);
  const expense = (await db.query('SELECT e.*, u.display_name as user_name FROM expenses e JOIN users u ON e.user_id = u.id WHERE e.id = $1', [req.params.id])).rows[0];
  res.json(expense);
});

// Expense summary by period (week/month/year) with per-user breakdown
app.get('/api/expenses/summary', authMiddleware, async (req, res) => {
  const db = await getDb();
  const now = new Date();

  // Week start (Monday)
  const todayDay = now.getDay();
  const diffToMonday = todayDay === 0 ? 6 : todayDay - 1;
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - diffToMonday);
  weekStart.setHours(0, 0, 0, 0);
  const weekStartStr = weekStart.toISOString().split('T')[0];

  // Month start
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  // Year start
  const yearStart = `${now.getFullYear()}-01-01`;

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
});

// ===================== INCOME ROUTES =====================

app.get('/api/income', authMiddleware, async (req, res) => {
  const db = await getDb();
  const { start, end } = req.query;
  let query = 'SELECT i.*, u.display_name as user_name FROM income_entries i JOIN users u ON i.user_id = u.id WHERE 1=1';
  const params = [];
  let paramIdx = 1;
  if (start) { query += ` AND i.pay_date >= $${paramIdx++}`; params.push(start); }
  if (end) { query += ` AND i.pay_date <= $${paramIdx++}`; params.push(end); }
  query += ' ORDER BY i.pay_date DESC';
  res.json((await db.query(query, params)).rows);
});

app.post('/api/income', authMiddleware, async (req, res) => {
  const { amount, net_amount, pay_date, pay_type, notes } = req.body;
  const db = await getDb();
  const result = await db.query(
    'INSERT INTO income_entries (user_id, amount, net_amount, pay_date, pay_type, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [req.user.id, amount, net_amount || null, pay_date, pay_type || 'regular', notes || null]
  );
  res.json(result.rows[0]);
});

// ===================== FUND ALLOCATION ROUTES =====================

app.get('/api/allocations', authMiddleware, async (req, res) => {
  const db = await getDb();
  const { rows } = await db.query('SELECT f.*, u.display_name as user_name FROM fund_allocations f JOIN users u ON f.user_id = u.id ORDER BY f.allocated_date DESC');
  res.json(rows);
});

app.post('/api/allocations', authMiddleware, async (req, res) => {
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
});

// ===================== ACCOUNT BALANCES =====================

app.get('/api/balances', authMiddleware, async (req, res) => {
  const db = await getDb();
  const accounts = ['offset', 'savings', 'credit_card', 'investment'];
  const balances = {};
  for (const acct of accounts) {
    const row = (await db.query('SELECT balance FROM account_balances WHERE account_type = $1 ORDER BY updated_at DESC LIMIT 1', [acct])).rows[0];
    balances[acct] = row ? row.balance : 0;
  }
  res.json(balances);
});

app.put('/api/balances/:account', authMiddleware, async (req, res) => {
  const { balance } = req.body;
  const db = await getDb();
  await db.query('INSERT INTO account_balances (account_type, balance, updated_by) VALUES ($1, $2, $3)', [req.params.account, balance, req.user.id]);
  res.json({ account: req.params.account, balance });
});

// ===================== SAVINGS GOALS =====================

app.get('/api/goals', authMiddleware, async (req, res) => {
  const db = await getDb();
  res.json((await db.query('SELECT g.*, u.display_name as created_by_name FROM savings_goals g JOIN users u ON g.created_by = u.id WHERE g.active = 1 ORDER BY g.priority ASC')).rows);
});

app.post('/api/goals', authMiddleware, async (req, res) => {
  const { name, target_amount, current_amount, priority, target_date, is_joint } = req.body;
  const db = await getDb();
  const result = await db.query(
    'INSERT INTO savings_goals (name, target_amount, current_amount, priority, target_date, created_by, is_joint) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
    [name, target_amount, current_amount || 0, priority || 5, target_date || null, req.user.id, is_joint !== undefined ? (is_joint ? 1 : 0) : 1]
  );
  res.json(result.rows[0]);
});

app.put('/api/goals/:id', authMiddleware, async (req, res) => {
  const { name, target_amount, current_amount, priority, target_date, active } = req.body;
  const db = await getDb();
  await db.query(
    'UPDATE savings_goals SET name = COALESCE($1, name), target_amount = COALESCE($2, target_amount), current_amount = COALESCE($3, current_amount), priority = COALESCE($4, priority), target_date = COALESCE($5, target_date), active = COALESCE($6, active) WHERE id = $7',
    [name, target_amount, current_amount, priority, target_date, active, req.params.id]
  );
  const goal = (await db.query('SELECT * FROM savings_goals WHERE id = $1', [req.params.id])).rows[0];
  res.json(goal);
});

app.delete('/api/goals/:id', authMiddleware, async (req, res) => {
  const db = await getDb();
  await db.query('UPDATE savings_goals SET active = 0 WHERE id = $1', [req.params.id]);
  res.json({ message: 'Goal deactivated' });
});

// ===================== LEVERS =====================

app.get('/api/levers', authMiddleware, async (req, res) => {
  const db = await getDb();
  res.json((await db.query('SELECT l.*, u.display_name as set_by_name FROM levers l JOIN users u ON l.set_by = u.id WHERE l.active = 1 ORDER BY l.id')).rows);
});

app.post('/api/levers', authMiddleware, async (req, res) => {
  const { name, description, lever_type, value } = req.body;
  const db = await getDb();
  const result = await db.query(
    'INSERT INTO levers (name, description, lever_type, value, set_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [name, description || null, lever_type || 'percentage', value, req.user.id]
  );
  res.json(result.rows[0]);
});

app.put('/api/levers/:id', authMiddleware, async (req, res) => {
  const { value, name, description } = req.body;
  const db = await getDb();
  await db.query(
    'UPDATE levers SET value = COALESCE($1, value), name = COALESCE($2, name), description = COALESCE($3, description), set_by = $4, updated_at = NOW() WHERE id = $5',
    [value, name, description, req.user.id, req.params.id]
  );
  const lever = (await db.query('SELECT * FROM levers WHERE id = $1', [req.params.id])).rows[0];
  res.json(lever);
});

app.delete('/api/levers/:id', authMiddleware, async (req, res) => {
  const db = await getDb();
  await db.query('UPDATE levers SET active = 0 WHERE id = $1', [req.params.id]);
  res.json({ message: 'Lever deactivated' });
});

// ===================== UPCOMING EXPENSES =====================

app.get('/api/upcoming-expenses', authMiddleware, async (req, res) => {
  const db = await getDb();
  res.json((await db.query('SELECT ue.*, u.display_name as user_name FROM upcoming_expenses ue JOIN users u ON ue.user_id = u.id WHERE ue.resolved = 0 ORDER BY ue.expected_date ASC')).rows);
});

app.post('/api/upcoming-expenses', authMiddleware, async (req, res) => {
  const { description, estimated_amount, expected_date, category, notes } = req.body;
  const db = await getDb();
  const result = await db.query(
    'INSERT INTO upcoming_expenses (user_id, description, estimated_amount, expected_date, category, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [req.user.id, description, estimated_amount, expected_date, category || null, notes || null]
  );
  res.json(result.rows[0]);
});

app.put('/api/upcoming-expenses/:id', authMiddleware, async (req, res) => {
  const { resolved } = req.body;
  const db = await getDb();
  await db.query('UPDATE upcoming_expenses SET resolved = $1 WHERE id = $2', [resolved ? 1 : 0, req.params.id]);
  res.json({ message: 'Updated' });
});

// ===================== CLAUDE AI ROUTES =====================

app.post('/api/claude/payday-advice', authMiddleware, async (req, res) => {
  const { net_pay, upcoming_expenses_override } = req.body;
  const db = await getDb();
  const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];

  // Get account balances
  const accounts = ['offset', 'savings', 'credit_card', 'investment'];
  const accountBalances = {};
  for (const acct of accounts) {
    const row = (await db.query('SELECT balance FROM account_balances WHERE account_type = $1 ORDER BY updated_at DESC LIMIT 1', [acct])).rows[0];
    accountBalances[acct] = row ? row.balance : 0;
  }

  const goals = (await db.query('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;
  const levers = (await db.query('SELECT * FROM levers WHERE active = 1')).rows;
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
  const recentExpenses = (await db.query('SELECT * FROM expenses WHERE expense_date >= $1 ORDER BY expense_date DESC', [twoWeeksAgo])).rows;
  const upcomingExpenses = upcoming_expenses_override ||
    (await db.query('SELECT * FROM upcoming_expenses WHERE resolved = 0 ORDER BY expected_date ASC')).rows;

  try {
    const result = await getPayDayAdvice({
      user, netPay: net_pay, accountBalances, goals, levers, recentExpenses, upcomingExpenses
    });
    // Store advice
    await db.query('INSERT INTO claude_advice (advice_type, content, context_data) VALUES ($1, $2, $3)',
      ['payday', result.advice, JSON.stringify({ net_pay, user_id: req.user.id })]
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/claude/account-sweep', authMiddleware, async (req, res) => {
  const { transaction_balance } = req.body;
  const db = await getDb();
  const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];

  const accounts = ['offset', 'savings', 'credit_card', 'investment'];
  const accountBalances = {};
  for (const acct of accounts) {
    const row = (await db.query('SELECT balance FROM account_balances WHERE account_type = $1 ORDER BY updated_at DESC LIMIT 1', [acct])).rows[0];
    accountBalances[acct] = row ? row.balance : 0;
  }

  const goals = (await db.query('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;
  const levers = (await db.query('SELECT * FROM levers WHERE active = 1')).rows;
  const budgets = (await db.query('SELECT * FROM category_budgets')).rows;
  const budgetScale = (levers.find(l => l.name.includes('Budget Scale'))?.value || 100) / 100;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const recentExpenses = (await db.query('SELECT * FROM expenses WHERE expense_date >= $1 ORDER BY expense_date DESC', [thirtyDaysAgo])).rows;
  const upcomingExpenses = (await db.query('SELECT * FROM upcoming_expenses WHERE resolved = 0 ORDER BY expected_date ASC')).rows;

  try {
    const result = await getAccountSweepAdvice({
      user, transactionBalance: transaction_balance, accountBalances, goals, levers, recentExpenses, upcomingExpenses, budgets, budgetScale
    });
    await db.query('INSERT INTO claude_advice (advice_type, content, context_data) VALUES ($1, $2, $3)',
      ['account-sweep', result.advice, JSON.stringify({ transaction_balance, user_id: req.user.id })]
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== CREDIT CARD STATEMENT IMPORT =====================

app.post('/api/statements/parse', authMiddleware, (req, res) => {
  const { csv_text } = req.body;
  if (!csv_text || !csv_text.trim()) {
    return res.status(400).json({ error: 'No CSV data provided' });
  }

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
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCSVLine(line);
    const rawDate = cols[dateCol]?.trim();
    const description = cols[descCol >= 0 ? descCol : 0]?.trim() || '';

    // Parse amount — handle debit/credit columns or single amount
    let amount = 0;
    if (debitCol >= 0 && creditCol >= 0) {
      const debit = parseFloat((cols[debitCol] || '').replace(/[$,]/g, '')) || 0;
      const credit = parseFloat((cols[creditCol] || '').replace(/[$,]/g, '')) || 0;
      amount = debit > 0 ? debit : -credit;
    } else {
      amount = parseFloat((cols[amountCol] || '').replace(/[$,]/g, '')) || 0;
    }

    // Skip zero-amount rows, payments (credits), and header-like rows
    if (amount <= 0) continue;

    // Parse date — try common formats
    const parsedDate = parseStatementDate(rawDate);
    if (!parsedDate) continue;

    // Auto-categorize based on description
    const category = autoCategorizeTxn(description);

    transactions.push({
      expense_date: parsedDate,
      description: description,
      amount: Math.round(amount * 100) / 100,
      category: category,
      entry_type: 'actual',
      source: 'credit_card_statement'
    });
  }

  res.json({ transactions, column_mapping: { dateCol, amountCol, descCol, creditCol, debitCol }, row_count: lines.length - 1 });
});

app.post('/api/statements/import', authMiddleware, async (req, res) => {
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
});

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

app.post('/api/claude/nightly-summary', authMiddleware, async (req, res) => {
  const db = await getDb();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];

  const expenses = (await db.query('SELECT * FROM expenses WHERE expense_date >= $1', [thirtyDaysAgo])).rows;
  const incomes = (await db.query('SELECT * FROM income_entries WHERE pay_date >= $1', [thirtyDaysAgo])).rows;

  const accounts = ['offset', 'savings', 'credit_card', 'investment'];
  const accountBalances = {};
  for (const acct of accounts) {
    const row = (await db.query('SELECT balance FROM account_balances WHERE account_type = $1 ORDER BY updated_at DESC LIMIT 1', [acct])).rows[0];
    accountBalances[acct] = row ? row.balance : 0;
  }

  const goals = (await db.query('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;
  const levers = (await db.query('SELECT * FROM levers WHERE active = 1')).rows;

  try {
    const result = await getNightlySummary({
      expenses, incomes, accountBalances, goals, levers, period: `${thirtyDaysAgo} to ${today}`
    });
    await db.query('INSERT INTO claude_advice (advice_type, content) VALUES ($1, $2)', ['nightly', result.summary]);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/claude/latest-advice', authMiddleware, async (req, res) => {
  const db = await getDb();
  const { type } = req.query;
  let query = 'SELECT * FROM claude_advice';
  const params = [];
  if (type) { query += ' WHERE advice_type = $1'; params.push(type); }
  query += ' ORDER BY created_at DESC LIMIT 1';
  const row = (await db.query(query, params)).rows[0];
  res.json(row || { content: 'No advice generated yet. Click "Get Claude Advice" to generate.', advice_type: type || 'nightly' });
});

// ===================== SCREENSHOT TRANSACTION IMPORT =====================

app.post('/api/screenshots/extract', authMiddleware, async (req, res) => {
  try {
    const { image, media_type } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });

    const result = await extractTransactionsFromImage(image, media_type || 'image/png');
    if (result.error) return res.status(500).json({ error: result.error });

    // Auto-categorize each extracted transaction
    const categorized = result.transactions.map(t => ({
      ...t,
      category: autoCategorizeTxn(t.description)
    }));

    res.json({ transactions: categorized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/screenshots/import', authMiddleware, async (req, res) => {
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
});

// ===================== CATEGORY BUDGETS =====================

app.get('/api/budgets', authMiddleware, async (req, res) => {
  const db = await getDb();
  res.json((await db.query('SELECT * FROM category_budgets ORDER BY category')).rows);
});

app.put('/api/budgets/:category', authMiddleware, async (req, res) => {
  const { monthly_amount } = req.body;
  const db = await getDb();
  await db.query('UPDATE category_budgets SET monthly_amount = $1, updated_at = NOW() WHERE category = $2', [monthly_amount, req.params.category]);
  const row = (await db.query('SELECT * FROM category_budgets WHERE category = $1', [req.params.category])).rows[0];
  res.json(row);
});

// ===================== INSIGHTS (Household Pulse) =====================

app.get('/api/insights', authMiddleware, async (req, res) => {
  const db = await getDb();
  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

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

  // Daily spending (last 14 days)
  const dailySpending = [];
  for (let d = 13; d >= 0; d--) {
    const date = new Date(Date.now() - d * 86400000).toISOString().split('T')[0];
    const row = (await db.query('SELECT SUM(amount) as total, COUNT(*) as cnt FROM expenses WHERE expense_date = $1', [date])).rows[0];
    dailySpending.push({ date: date.substring(5), total: parseFloat(row.total) || 0, count: parseInt(row.cnt) });
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
});

// ===================== DASHBOARD / SUMMARY =====================

app.get('/api/dashboard', authMiddleware, async (req, res) => {
  const db = await getDb();
  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

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
  const mortgage = 4587.83;

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
    budgeted_expenses: Math.round(totalMonthlyBudget),
    weekly_budget: Math.round(weeklyBudget),
    budget_by_category: budgets.map(b => ({ category: b.category, budget: Math.round(b.monthly_amount * budgetScale) }))
  });
});

// ===================== DATA BACKUP =====================

// Full JSON backup of all data (for disaster recovery)
app.get('/api/backup', authMiddleware, async (req, res) => {
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
});

// Restore data from JSON backup
app.post('/api/backup/restore', authMiddleware, async (req, res) => {
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
});

// ===================== EXPORT =====================

app.get('/api/export', authMiddleware, async (req, res) => {
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
});

// ===================== PROJECTIONS =====================

app.get('/api/projections', authMiddleware, async (req, res) => {
  const db = await getDb();
  const users = (await db.query('SELECT * FROM users')).rows;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const monthlyExpenses = (await db.query('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= $1', [thirtyDaysAgo])).rows[0];

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
  const mortgage = 4587.83;
  const monthlySurplus = monthlyNetIncome - monthlyExpenseAvg - mortgage;

  const accounts = ['offset', 'savings', 'credit_card', 'investment'];
  const balances = {};
  for (const acct of accounts) {
    const row = (await db.query('SELECT balance FROM account_balances WHERE account_type = $1 ORDER BY updated_at DESC LIMIT 1', [acct])).rows[0];
    balances[acct] = row ? row.balance : 0;
  }

  const goals = (await db.query('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;
  const levers = (await db.query('SELECT * FROM levers WHERE active = 1')).rows;

  // Budget data
  const budgets = (await db.query('SELECT * FROM category_budgets')).rows;
  const budgetScale = (levers.find(l => l.name.includes('Budget Scale'))?.value || 100) / 100;
  const totalMonthlyBudget = budgets.reduce((sum, b) => sum + b.monthly_amount * budgetScale, 0);
  const budgetedSurplus = monthlyNetIncome - totalMonthlyBudget - mortgage;

  // Project 12 months using budgeted surplus (the plan)
  const projections = [];
  let runningOffset = balances.offset;
  let runningSavings = balances.savings;
  let runningInvestment = balances.investment;

  const offsetPct = (levers.find(l => l.name.includes('Offset'))?.value || 50) / 100;
  const savingsPct = (levers.find(l => l.name.includes('Savings') && l.name.includes('%'))?.value || 30) / 100;
  const investPct = (levers.find(l => l.name.includes('Investment'))?.value || 10) / 100;

  for (let m = 1; m <= 12; m++) {
    const date = new Date();
    date.setMonth(date.getMonth() + m);
    const surplus = Math.max(0, budgetedSurplus);
    runningOffset += surplus * offsetPct;
    runningSavings += surplus * savingsPct;
    runningInvestment += surplus * investPct;
    projections.push({
      month: date.toISOString().substring(0, 7),
      offset: Math.round(runningOffset),
      savings: Math.round(runningSavings),
      investment: Math.round(runningInvestment),
      surplus: Math.round(surplus),
      total_net_worth: Math.round(runningOffset + runningSavings + runningInvestment)
    });
  }

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
    pets: { low: 50, mid: 100, high: 200, label: 'Pets' },
    gifts: { low: 50, mid: 100, high: 200, label: 'Gifts' }
  };

  const status = monthlySurplus > 500 ? 'great' : monthlySurplus > 0 ? 'okay' : 'warning';
  const message = monthlySurplus > 500
    ? `You're saving ~$${Math.round(monthlySurplus)}/month after mortgage. Keep it up!`
    : monthlySurplus > 0
    ? `Tight but positive: ~$${Math.round(monthlySurplus)}/month surplus. Look for ways to increase this.`
    : `Warning: spending exceeds income by ~$${Math.round(Math.abs(monthlySurplus))}/month. Immediate action needed.`;

  res.json({
    monthly_net_income: Math.round(monthlyNetIncome),
    monthly_expenses: Math.round(monthlyExpenseAvg),
    mortgage,
    monthly_surplus: Math.round(monthlySurplus),
    budgeted_expenses: Math.round(totalMonthlyBudget),
    budgeted_surplus: Math.round(budgetedSurplus),
    projections,
    balances,
    goals,
    benchmarks: sydneyBenchmarks,
    status,
    message
  });
});

// Nightly cron job for Claude summary (runs at 9pm AEST = 11:00 UTC)
cron.schedule('0 11 * * *', async () => {
  console.log('Running nightly Claude summary...');
  try {
    const db = await getDb();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const today = new Date().toISOString().split('T')[0];
    const expenses = (await db.query('SELECT * FROM expenses WHERE expense_date >= $1', [thirtyDaysAgo])).rows;
    const incomes = (await db.query('SELECT * FROM income_entries WHERE pay_date >= $1', [thirtyDaysAgo])).rows;
    const accounts = ['offset', 'savings', 'credit_card', 'investment'];
    const accountBalances = {};
    for (const acct of accounts) {
      const row = (await db.query('SELECT balance FROM account_balances WHERE account_type = $1 ORDER BY updated_at DESC LIMIT 1', [acct])).rows[0];
      accountBalances[acct] = row ? row.balance : 0;
    }
    const goals = (await db.query('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;
    const levers = (await db.query('SELECT * FROM levers WHERE active = 1')).rows;
    const result = await getNightlySummary({ expenses, incomes, accountBalances, goals, levers, period: `${thirtyDaysAgo} to ${today}` });
    await db.query('INSERT INTO claude_advice (advice_type, content) VALUES ($1, $2)', ['nightly', result.summary]);
    console.log('Nightly summary saved.');
  } catch (err) {
    console.error('Nightly summary error:', err.message);
  }
});

// SPA fallback
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Budget server running on port ${PORT}`);
});
