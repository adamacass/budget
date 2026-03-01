require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const XLSX = require('xlsx');
const { getDb } = require('./db');
const { generateToken, authMiddleware } = require('./auth');
const { getPayDayAdvice, getNightlySummary, getAccountSweepAdvice } = require('./claude');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Serve static frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
}

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

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
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

app.post('/api/auth/register', (req, res) => {
  const { username, password, display_name, gross_income, pay_cycle, super_rate, hecs_repayment_rate } = req.body;
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: 'Username already taken' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, gross_income, super_rate, hecs_repayment_rate, pay_cycle) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(username, display_name, hash, gross_income || 0, super_rate || 0.115, hecs_repayment_rate || 0, pay_cycle || 'fortnightly');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  const token = generateToken(user);
  res.json({ token, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, gross_income: user.gross_income, pay_cycle: user.pay_cycle } });
});

app.put('/api/auth/profile', authMiddleware, (req, res) => {
  const { display_name, gross_income, super_rate, hecs_repayment_rate, pay_cycle } = req.body;
  const db = getDb();
  db.prepare(
    'UPDATE users SET display_name = COALESCE(?, display_name), gross_income = COALESCE(?, gross_income), super_rate = COALESCE(?, super_rate), hecs_repayment_rate = COALESCE(?, hecs_repayment_rate), pay_cycle = COALESCE(?, pay_cycle) WHERE id = ?'
  ).run(display_name, gross_income, super_rate, hecs_repayment_rate, pay_cycle, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ id: user.id, username: user.username, display_name: user.display_name, role: user.role, gross_income: user.gross_income, super_rate: user.super_rate, hecs_repayment_rate: user.hecs_repayment_rate, pay_cycle: user.pay_cycle });
});

app.put('/api/auth/password', authMiddleware, (req, res) => {
  const { current_password, new_password } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ message: 'Password updated' });
});

// ===================== EXPENSE ROUTES =====================

app.get('/api/expenses', authMiddleware, (req, res) => {
  const db = getDb();
  const { start, end, category, user_id } = req.query;
  let query = 'SELECT e.*, u.display_name as user_name FROM expenses e JOIN users u ON e.user_id = u.id WHERE 1=1';
  const params = [];

  if (start) { query += ' AND e.expense_date >= ?'; params.push(start); }
  if (end) { query += ' AND e.expense_date <= ?'; params.push(end); }
  if (category) { query += ' AND e.category = ?'; params.push(category); }
  if (user_id) { query += ' AND e.user_id = ?'; params.push(user_id); }

  query += ' ORDER BY e.expense_date DESC, e.created_at DESC';
  res.json(db.prepare(query).all(...params));
});

app.post('/api/expenses', authMiddleware, (req, res) => {
  const { category, subcategory, description, amount, expense_date, entry_type, is_range, range_low, range_high, recurring } = req.body;
  const db = getDb();
  const result = db.prepare(
    'INSERT INTO expenses (user_id, category, subcategory, description, amount, expense_date, entry_type, is_range, range_low, range_high, recurring) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, category, subcategory || null, description || null, amount, expense_date, entry_type || 'actual', is_range ? 1 : 0, range_low || null, range_high || null, recurring ? 1 : 0);
  const expense = db.prepare('SELECT e.*, u.display_name as user_name FROM expenses e JOIN users u ON e.user_id = u.id WHERE e.id = ?').get(result.lastInsertRowid);
  res.json(expense);
});

app.post('/api/expenses/batch', authMiddleware, (req, res) => {
  const { expenses } = req.body;
  const db = getDb();
  const insert = db.prepare(
    'INSERT INTO expenses (user_id, category, subcategory, description, amount, expense_date, entry_type, is_range, range_low, range_high, recurring) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertMany = db.transaction((items) => {
    for (const e of items) {
      insert.run(req.user.id, e.category, e.subcategory || null, e.description || null, e.amount, e.expense_date, e.entry_type || 'actual', e.is_range ? 1 : 0, e.range_low || null, e.range_high || null, e.recurring ? 1 : 0);
    }
  });
  insertMany(expenses);
  res.json({ message: `${expenses.length} expenses added` });
});

app.delete('/api/expenses/:id', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM expenses WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ message: 'Deleted' });
});

// ===================== INCOME ROUTES =====================

app.get('/api/income', authMiddleware, (req, res) => {
  const db = getDb();
  const { start, end } = req.query;
  let query = 'SELECT i.*, u.display_name as user_name FROM income_entries i JOIN users u ON i.user_id = u.id WHERE 1=1';
  const params = [];
  if (start) { query += ' AND i.pay_date >= ?'; params.push(start); }
  if (end) { query += ' AND i.pay_date <= ?'; params.push(end); }
  query += ' ORDER BY i.pay_date DESC';
  res.json(db.prepare(query).all(...params));
});

app.post('/api/income', authMiddleware, (req, res) => {
  const { amount, net_amount, pay_date, pay_type, notes } = req.body;
  const db = getDb();
  const result = db.prepare(
    'INSERT INTO income_entries (user_id, amount, net_amount, pay_date, pay_type, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, amount, net_amount || null, pay_date, pay_type || 'regular', notes || null);
  const entry = db.prepare('SELECT * FROM income_entries WHERE id = ?').get(result.lastInsertRowid);
  res.json(entry);
});

// ===================== FUND ALLOCATION ROUTES =====================

app.get('/api/allocations', authMiddleware, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT f.*, u.display_name as user_name FROM fund_allocations f JOIN users u ON f.user_id = u.id ORDER BY f.allocated_date DESC').all();
  res.json(rows);
});

app.post('/api/allocations', authMiddleware, (req, res) => {
  const { income_entry_id, allocations } = req.body;
  const db = getDb();
  const insert = db.prepare(
    'INSERT INTO fund_allocations (user_id, income_entry_id, target_account, amount, allocated_date, notes) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertAll = db.transaction((items) => {
    for (const a of items) {
      insert.run(req.user.id, income_entry_id || null, a.target_account, a.amount, a.allocated_date || new Date().toISOString().split('T')[0], a.notes || null);
      // Update account balance
      const existing = db.prepare('SELECT * FROM account_balances WHERE account_type = ? ORDER BY updated_at DESC LIMIT 1').get(a.target_account);
      const newBalance = (existing ? existing.balance : 0) + a.amount;
      db.prepare('INSERT INTO account_balances (account_type, balance, updated_by) VALUES (?, ?, ?)').run(a.target_account, newBalance, req.user.id);
    }
  });
  insertAll(allocations);
  res.json({ message: 'Allocations saved' });
});

// ===================== ACCOUNT BALANCES =====================

app.get('/api/balances', authMiddleware, (req, res) => {
  const db = getDb();
  const accounts = ['offset', 'savings', 'credit_card', 'investment'];
  const balances = {};
  for (const acct of accounts) {
    const row = db.prepare('SELECT balance FROM account_balances WHERE account_type = ? ORDER BY updated_at DESC LIMIT 1').get(acct);
    balances[acct] = row ? row.balance : 0;
  }
  res.json(balances);
});

app.put('/api/balances/:account', authMiddleware, (req, res) => {
  const { balance } = req.body;
  const db = getDb();
  db.prepare('INSERT INTO account_balances (account_type, balance, updated_by) VALUES (?, ?, ?)').run(req.params.account, balance, req.user.id);
  res.json({ account: req.params.account, balance });
});

// ===================== SAVINGS GOALS =====================

app.get('/api/goals', authMiddleware, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT g.*, u.display_name as created_by_name FROM savings_goals g JOIN users u ON g.created_by = u.id WHERE g.active = 1 ORDER BY g.priority ASC').all());
});

app.post('/api/goals', authMiddleware, (req, res) => {
  const { name, target_amount, current_amount, priority, target_date, is_joint } = req.body;
  const db = getDb();
  const result = db.prepare(
    'INSERT INTO savings_goals (name, target_amount, current_amount, priority, target_date, created_by, is_joint) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(name, target_amount, current_amount || 0, priority || 5, target_date || null, req.user.id, is_joint !== undefined ? (is_joint ? 1 : 0) : 1);
  const goal = db.prepare('SELECT * FROM savings_goals WHERE id = ?').get(result.lastInsertRowid);
  res.json(goal);
});

app.put('/api/goals/:id', authMiddleware, (req, res) => {
  const { name, target_amount, current_amount, priority, target_date, active } = req.body;
  const db = getDb();
  db.prepare(
    'UPDATE savings_goals SET name = COALESCE(?, name), target_amount = COALESCE(?, target_amount), current_amount = COALESCE(?, current_amount), priority = COALESCE(?, priority), target_date = COALESCE(?, target_date), active = COALESCE(?, active) WHERE id = ?'
  ).run(name, target_amount, current_amount, priority, target_date, active, req.params.id);
  const goal = db.prepare('SELECT * FROM savings_goals WHERE id = ?').get(req.params.id);
  res.json(goal);
});

app.delete('/api/goals/:id', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE savings_goals SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ message: 'Goal deactivated' });
});

// ===================== LEVERS =====================

app.get('/api/levers', authMiddleware, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT l.*, u.display_name as set_by_name FROM levers l JOIN users u ON l.set_by = u.id WHERE l.active = 1 ORDER BY l.id').all());
});

app.post('/api/levers', authMiddleware, (req, res) => {
  const { name, description, lever_type, value } = req.body;
  const db = getDb();
  const result = db.prepare(
    'INSERT INTO levers (name, description, lever_type, value, set_by) VALUES (?, ?, ?, ?, ?)'
  ).run(name, description || null, lever_type || 'percentage', value, req.user.id);
  const lever = db.prepare('SELECT * FROM levers WHERE id = ?').get(result.lastInsertRowid);
  res.json(lever);
});

app.put('/api/levers/:id', authMiddleware, (req, res) => {
  const { value, name, description } = req.body;
  const db = getDb();
  db.prepare(
    "UPDATE levers SET value = COALESCE(?, value), name = COALESCE(?, name), description = COALESCE(?, description), set_by = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(value, name, description, req.user.id, req.params.id);
  const lever = db.prepare('SELECT * FROM levers WHERE id = ?').get(req.params.id);
  res.json(lever);
});

app.delete('/api/levers/:id', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE levers SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ message: 'Lever deactivated' });
});

// ===================== UPCOMING EXPENSES =====================

app.get('/api/upcoming-expenses', authMiddleware, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT ue.*, u.display_name as user_name FROM upcoming_expenses ue JOIN users u ON ue.user_id = u.id WHERE ue.resolved = 0 ORDER BY ue.expected_date ASC').all());
});

app.post('/api/upcoming-expenses', authMiddleware, (req, res) => {
  const { description, estimated_amount, expected_date, category, notes } = req.body;
  const db = getDb();
  const result = db.prepare(
    'INSERT INTO upcoming_expenses (user_id, description, estimated_amount, expected_date, category, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, description, estimated_amount, expected_date, category || null, notes || null);
  const entry = db.prepare('SELECT * FROM upcoming_expenses WHERE id = ?').get(result.lastInsertRowid);
  res.json(entry);
});

app.put('/api/upcoming-expenses/:id', authMiddleware, (req, res) => {
  const { resolved } = req.body;
  const db = getDb();
  db.prepare('UPDATE upcoming_expenses SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, req.params.id);
  res.json({ message: 'Updated' });
});

// ===================== CLAUDE AI ROUTES =====================

app.post('/api/claude/payday-advice', authMiddleware, async (req, res) => {
  const { net_pay, upcoming_expenses_override } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  // Get account balances
  const accounts = ['offset', 'savings', 'credit_card', 'investment'];
  const accountBalances = {};
  for (const acct of accounts) {
    const row = db.prepare('SELECT balance FROM account_balances WHERE account_type = ? ORDER BY updated_at DESC LIMIT 1').get(acct);
    accountBalances[acct] = row ? row.balance : 0;
  }

  const goals = db.prepare('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority').all();
  const levers = db.prepare('SELECT * FROM levers WHERE active = 1').all();
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
  const recentExpenses = db.prepare('SELECT * FROM expenses WHERE expense_date >= ? ORDER BY expense_date DESC').all(twoWeeksAgo);
  const upcomingExpenses = upcoming_expenses_override ||
    db.prepare('SELECT * FROM upcoming_expenses WHERE resolved = 0 ORDER BY expected_date ASC').all();

  try {
    const result = await getPayDayAdvice({
      user, netPay: net_pay, accountBalances, goals, levers, recentExpenses, upcomingExpenses
    });
    // Store advice
    db.prepare('INSERT INTO claude_advice (advice_type, content, context_data) VALUES (?, ?, ?)').run(
      'payday', result.advice, JSON.stringify({ net_pay, user_id: req.user.id })
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/claude/account-sweep', authMiddleware, async (req, res) => {
  const { transaction_balance } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  const accounts = ['offset', 'savings', 'credit_card', 'investment'];
  const accountBalances = {};
  for (const acct of accounts) {
    const row = db.prepare('SELECT balance FROM account_balances WHERE account_type = ? ORDER BY updated_at DESC LIMIT 1').get(acct);
    accountBalances[acct] = row ? row.balance : 0;
  }

  const goals = db.prepare('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority').all();
  const levers = db.prepare('SELECT * FROM levers WHERE active = 1').all();
  const budgets = db.prepare('SELECT * FROM category_budgets').all();
  const budgetScale = (levers.find(l => l.name.includes('Budget Scale'))?.value || 100) / 100;

  // Get expenses from last 30 days for context (also used for month-to-date calc inside prompt)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const recentExpenses = db.prepare('SELECT * FROM expenses WHERE expense_date >= ? ORDER BY expense_date DESC').all(thirtyDaysAgo);
  const upcomingExpenses = db.prepare('SELECT * FROM upcoming_expenses WHERE resolved = 0 ORDER BY expected_date ASC').all();

  try {
    const result = await getAccountSweepAdvice({
      user, transactionBalance: transaction_balance, accountBalances, goals, levers, recentExpenses, upcomingExpenses, budgets, budgetScale
    });
    db.prepare('INSERT INTO claude_advice (advice_type, content, context_data) VALUES (?, ?, ?)').run(
      'account-sweep', result.advice, JSON.stringify({ transaction_balance, user_id: req.user.id })
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
      amount = debit > 0 ? debit : -credit; // Positive = expense, negative = refund/payment
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

app.post('/api/statements/import', authMiddleware, (req, res) => {
  const { transactions } = req.body;
  if (!transactions || !transactions.length) {
    return res.status(400).json({ error: 'No transactions to import' });
  }

  const db = getDb();
  const insert = db.prepare(
    'INSERT INTO expenses (user_id, category, subcategory, description, amount, expense_date, entry_type, is_range, range_low, range_high, recurring) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 0)'
  );
  const importAll = db.transaction((items) => {
    for (const t of items) {
      insert.run(req.user.id, t.category, t.source || 'credit_card_statement', t.description, t.amount, t.expense_date, t.entry_type || 'actual');
    }
  });
  importAll(transactions);
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

// Simple keyword-based auto-categorizer
function autoCategorizeTxn(desc) {
  const d = desc.toLowerCase();
  if (/woolworths|coles|aldi|iga|harris farm|market|grocer|fruit|butcher/.test(d)) return 'Groceries';
  if (/uber\s?eats|doordash|menulog|deliveroo|mcdonald|kfc|subway|pizza|burger|cafe|coffee|restaurant|bar\s|pub\s|tavern|dining|eat|brunch|lunch/.test(d)) return 'Dining Out';
  if (/uber|lyft|taxi|cabcharge|opal|linkt|toll|parking|fuel|petrol|bp\s|shell|caltex|ampol|7-?eleven|rego|rms|nrma|car\s?wash/.test(d)) return 'Transport';
  if (/energy|water|gas|telstra|optus|vodafone|tpg|iinet|internet|broadband|electricity|ausgrid|origin|agl/.test(d)) return 'Utilities';
  if (/insurance|allianz|qbe|suncorp|nib|medibank|bupa|hcf|ahm/.test(d)) return 'Insurance';
  if (/netflix|spotify|disney|stan|binge|kayo|apple\.com|youtube|amazon prime|subscribe|membership/.test(d)) return 'Subscriptions';
  if (/cinema|movies|ticket|event|concert|sport|game|bowling|golf|tennis|museum|zoo|theme park|luna park/.test(d)) return 'Entertainment';
  if (/pharmacy|chemist|doctor|gp\s|medical|dental|dentist|physio|gym|fitness|pool|yoga|pilates|health/.test(d)) return 'Health';
  if (/kmart|target|uniqlo|zara|h&m|cotton on|country road|myer|david jones|clothes|fashion|shoe/.test(d)) return 'Clothing';
  if (/hair|barber|beauty|nail|skin|spa|cosmetic|makeup|shav/.test(d)) return 'Personal Care';
  if (/pet|vet|petbarn|petsmart|pet circle|animal/.test(d)) return 'Pets';
  if (/gift|flower|present|hamper/.test(d)) return 'Gifts';
  if (/course|book|udemy|education|tutor|uni|school|tafe/.test(d)) return 'Education';
  if (/bunnings|ikea|officeworks|furniture|homeware|hardware|garden|plumb|electr/.test(d)) return 'Home';
  return 'Other';
}

app.post('/api/claude/nightly-summary', authMiddleware, async (req, res) => {
  const db = getDb();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];

  const expenses = db.prepare('SELECT * FROM expenses WHERE expense_date >= ?').all(thirtyDaysAgo);
  const incomes = db.prepare('SELECT * FROM income_entries WHERE pay_date >= ?').all(thirtyDaysAgo);

  const accounts = ['offset', 'savings', 'credit_card', 'investment'];
  const accountBalances = {};
  for (const acct of accounts) {
    const row = db.prepare('SELECT balance FROM account_balances WHERE account_type = ? ORDER BY updated_at DESC LIMIT 1').get(acct);
    accountBalances[acct] = row ? row.balance : 0;
  }

  const goals = db.prepare('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority').all();
  const levers = db.prepare('SELECT * FROM levers WHERE active = 1').all();

  try {
    const result = await getNightlySummary({
      expenses, incomes, accountBalances, goals, levers, period: `${thirtyDaysAgo} to ${today}`
    });
    db.prepare('INSERT INTO claude_advice (advice_type, content) VALUES (?, ?)').run('nightly', result.summary);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/claude/latest-advice', authMiddleware, (req, res) => {
  const db = getDb();
  const { type } = req.query;
  let query = 'SELECT * FROM claude_advice';
  const params = [];
  if (type) { query += ' WHERE advice_type = ?'; params.push(type); }
  query += ' ORDER BY created_at DESC LIMIT 1';
  const row = db.prepare(query).get(...params);
  res.json(row || { content: 'No advice generated yet. Click "Get Claude Advice" to generate.', advice_type: type || 'nightly' });
});

// ===================== CATEGORY BUDGETS =====================

app.get('/api/budgets', authMiddleware, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM category_budgets ORDER BY category').all());
});

app.put('/api/budgets/:category', authMiddleware, (req, res) => {
  const { monthly_amount } = req.body;
  const db = getDb();
  db.prepare("UPDATE category_budgets SET monthly_amount = ?, updated_at = datetime('now') WHERE category = ?").run(monthly_amount, req.params.category);
  const row = db.prepare('SELECT * FROM category_budgets WHERE category = ?').get(req.params.category);
  res.json(row);
});

// ===================== INSIGHTS (Household Pulse) =====================

app.get('/api/insights', authMiddleware, (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  // Per-user activity
  const users = db.prepare('SELECT id, display_name, username FROM users').all();
  const userActivity = users.map(u => {
    const lastExpense = db.prepare('SELECT expense_date FROM expenses WHERE user_id = ? ORDER BY expense_date DESC LIMIT 1').get(u.id);
    const monthCount = db.prepare('SELECT COUNT(*) as cnt FROM expenses WHERE user_id = ? AND expense_date >= ?').get(u.id, thirtyDaysAgo);
    const monthTotal = db.prepare('SELECT SUM(amount) as total FROM expenses WHERE user_id = ? AND expense_date >= ?').get(u.id, thirtyDaysAgo);

    // Streak: consecutive days with at least one expense (allow today gap)
    let streak = 0;
    for (let d = 0; d < 60; d++) {
      const date = new Date(Date.now() - d * 86400000).toISOString().split('T')[0];
      const has = db.prepare('SELECT COUNT(*) as cnt FROM expenses WHERE user_id = ? AND expense_date = ?').get(u.id, date);
      if (has.cnt > 0) streak++;
      else if (d > 0) break;
    }

    const daysSince = lastExpense
      ? Math.floor((Date.now() - new Date(lastExpense.expense_date + 'T12:00:00').getTime()) / 86400000)
      : null;

    return {
      user_id: u.id,
      display_name: u.display_name,
      last_expense_date: lastExpense?.expense_date || null,
      days_since_last: daysSince,
      month_count: monthCount.cnt,
      month_total: monthTotal.total || 0,
      streak,
    };
  });

  // Spending pace
  const totalMonth = db.prepare('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= ?').get(thirtyDaysAgo);
  const daysElapsed = Math.max(1, Math.floor((Date.now() - new Date(thirtyDaysAgo + 'T00:00:00').getTime()) / 86400000));
  const dailyAvg = (totalMonth.total || 0) / daysElapsed;

  // Daily spending (last 14 days)
  const dailySpending = [];
  for (let d = 13; d >= 0; d--) {
    const date = new Date(Date.now() - d * 86400000).toISOString().split('T')[0];
    const row = db.prepare('SELECT SUM(amount) as total, COUNT(*) as cnt FROM expenses WHERE expense_date = ?').get(date);
    dailySpending.push({ date: date.substring(5), total: row.total || 0, count: row.cnt });
  }

  // Top 5 biggest expenses this month
  const biggestExpenses = db.prepare(
    'SELECT e.category, e.description, e.amount, e.expense_date, u.display_name as user_name FROM expenses e JOIN users u ON e.user_id = u.id WHERE e.expense_date >= ? ORDER BY e.amount DESC LIMIT 5'
  ).all(thirtyDaysAgo);

  // Recent 5 expenses
  const recentExpenses = db.prepare(
    'SELECT e.id, e.category, e.description, e.amount, e.expense_date, u.display_name as user_name FROM expenses e JOIN users u ON e.user_id = u.id ORDER BY e.created_at DESC, e.id DESC LIMIT 5'
  ).all();

  // Offset interest insight
  const offsetRow = db.prepare('SELECT balance FROM account_balances WHERE account_type = ? ORDER BY updated_at DESC LIMIT 1').get('offset');
  const offsetBal = offsetRow ? offsetRow.balance : 0;
  const mortgageRate = 0.062;
  const monthlyInterestSaved = (offsetBal * mortgageRate) / 12;
  const annualInterestSaved = offsetBal * mortgageRate;

  // Budget data for pace comparison
  const budgets = db.prepare('SELECT * FROM category_budgets').all();
  const levers = db.prepare('SELECT * FROM levers WHERE active = 1').all();
  const budgetScale = (levers.find(l => l.name.includes('Budget Scale'))?.value || 100) / 100;
  const monthlyBudget = budgets.reduce((sum, b) => sum + b.monthly_amount * budgetScale, 0);

  res.json({
    user_activity: userActivity,
    spending_pace: {
      daily_average: Math.round(dailyAvg),
      projected_monthly: Math.round(dailyAvg * 30),
      monthly_budget: Math.round(monthlyBudget),
      days_elapsed: daysElapsed,
      total_spent: Math.round(totalMonth.total || 0),
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

app.get('/api/dashboard', authMiddleware, (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

  const monthlyExpenses = db.prepare('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= ?').get(thirtyDaysAgo);
  const weeklyExpenses = db.prepare('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= ?').get(sevenDaysAgo);
  const monthlyIncome = db.prepare('SELECT SUM(COALESCE(net_amount, amount)) as total FROM income_entries WHERE pay_date >= ?').get(thirtyDaysAgo);

  const expensesByCategory = db.prepare(
    'SELECT category, SUM(amount) as total, COUNT(*) as count FROM expenses WHERE expense_date >= ? GROUP BY category ORDER BY total DESC'
  ).all(thirtyDaysAgo);

  // Build Monday-based weeks
  const weeklyTrend = [];
  const now = new Date();
  // Find this Monday (day 0=Sun, 1=Mon...)
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
    const row = db.prepare('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= ? AND expense_date < ?').get(startStr, endStr);
    weeklyTrend.push({ week: label, total: row.total || 0, start: startStr, end: endStr });
  }

  const accounts = ['offset', 'savings', 'credit_card', 'investment'];
  const balances = {};
  for (const acct of accounts) {
    const row = db.prepare('SELECT balance FROM account_balances WHERE account_type = ? ORDER BY updated_at DESC LIMIT 1').get(acct);
    balances[acct] = row ? row.balance : 0;
  }

  const goals = db.prepare('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority').all();
  const users = db.prepare('SELECT id, display_name, gross_income, pay_cycle FROM users').all();

  // Budget data
  const budgets = db.prepare('SELECT * FROM category_budgets').all();
  const levers = db.prepare('SELECT * FROM levers WHERE active = 1').all();
  const budgetScale = (levers.find(l => l.name.includes('Budget Scale'))?.value || 100) / 100;
  const totalMonthlyBudget = budgets.reduce((sum, b) => sum + b.monthly_amount * budgetScale, 0);
  const weeklyBudget = totalMonthlyBudget * 12 / 52;

  // Estimated monthly income from tax calc
  const allUsers = db.prepare('SELECT * FROM users').all();
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
    monthly_expenses: monthlyExpenses.total || 0,
    weekly_expenses: weeklyExpenses.total || 0,
    monthly_income: monthlyIncome.total || 0,
    net_monthly: (monthlyIncome.total || 0) - (monthlyExpenses.total || 0),
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

// ===================== EXPORT =====================

app.get('/api/export', authMiddleware, (req, res) => {
  const db = getDb();
  const { start, end } = req.query;
  const s = start || new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
  const e = end || new Date().toISOString().split('T')[0];

  const expenses = db.prepare(
    'SELECT e.expense_date as Date, u.display_name as User, e.category as Category, e.subcategory as Subcategory, e.description as Description, e.amount as Amount, e.entry_type as Type FROM expenses e JOIN users u ON e.user_id = u.id WHERE e.expense_date >= ? AND e.expense_date <= ? ORDER BY e.expense_date DESC'
  ).all(s, e);

  const incomes = db.prepare(
    'SELECT i.pay_date as Date, u.display_name as User, i.amount as GrossAmount, i.net_amount as NetAmount, i.pay_type as Type, i.notes as Notes FROM income_entries i JOIN users u ON i.user_id = u.id WHERE i.pay_date >= ? AND i.pay_date <= ? ORDER BY i.pay_date DESC'
  ).all(s, e);

  const goals = db.prepare(
    'SELECT name as Goal, target_amount as Target, current_amount as Current, priority as Priority, target_date as TargetDate FROM savings_goals WHERE active = 1 ORDER BY priority'
  ).all();

  const accounts = ['offset', 'savings', 'credit_card', 'investment'];
  const balanceRows = accounts.map(acct => {
    const row = db.prepare('SELECT balance FROM account_balances WHERE account_type = ? ORDER BY updated_at DESC LIMIT 1').get(acct);
    return { Account: acct, Balance: row ? row.balance : 0 };
  });

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

app.get('/api/projections', authMiddleware, (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT * FROM users').all();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const monthlyExpenses = db.prepare('SELECT SUM(amount) as total FROM expenses WHERE expense_date >= ?').get(thirtyDaysAgo);

  // Calculate combined net income (rough estimate)
  let totalAnnualNet = 0;
  for (const u of users) {
    const grossExSuper = u.gross_income / (1 + u.super_rate);
    const taxable = grossExSuper;
    // Simplified AU tax brackets for 2024-25
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
  const monthlyExpenseAvg = monthlyExpenses.total || 0;
  const mortgage = 4587.83;
  const monthlySurplus = monthlyNetIncome - monthlyExpenseAvg - mortgage;

  const accounts = ['offset', 'savings', 'credit_card', 'investment'];
  const balances = {};
  for (const acct of accounts) {
    const row = db.prepare('SELECT balance FROM account_balances WHERE account_type = ? ORDER BY updated_at DESC LIMIT 1').get(acct);
    balances[acct] = row ? row.balance : 0;
  }

  const goals = db.prepare('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority').all();
  const levers = db.prepare('SELECT * FROM levers WHERE active = 1').all();

  // Budget data
  const budgets = db.prepare('SELECT * FROM category_budgets').all();
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
    const db = getDb();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const today = new Date().toISOString().split('T')[0];
    const expenses = db.prepare('SELECT * FROM expenses WHERE expense_date >= ?').all(thirtyDaysAgo);
    const incomes = db.prepare('SELECT * FROM income_entries WHERE pay_date >= ?').all(thirtyDaysAgo);
    const accounts = ['offset', 'savings', 'credit_card', 'investment'];
    const accountBalances = {};
    for (const acct of accounts) {
      const row = db.prepare('SELECT balance FROM account_balances WHERE account_type = ? ORDER BY updated_at DESC LIMIT 1').get(acct);
      accountBalances[acct] = row ? row.balance : 0;
    }
    const goals = db.prepare('SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority').all();
    const levers = db.prepare('SELECT * FROM levers WHERE active = 1').all();
    const result = await getNightlySummary({ expenses, incomes, accountBalances, goals, levers, period: `${thirtyDaysAgo} to ${today}` });
    db.prepare('INSERT INTO claude_advice (advice_type, content) VALUES (?, ?)').run('nightly', result.summary);
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
