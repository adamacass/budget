const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'budget.db');

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'partner',
      gross_income REAL NOT NULL DEFAULT 0,
      super_rate REAL NOT NULL DEFAULT 0.115,
      hecs_repayment_rate REAL NOT NULL DEFAULT 0,
      pay_cycle TEXT NOT NULL DEFAULT 'fortnightly',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      description TEXT,
      amount REAL NOT NULL,
      expense_date TEXT NOT NULL,
      entry_type TEXT NOT NULL DEFAULT 'actual',
      is_range INTEGER NOT NULL DEFAULT 0,
      range_low REAL,
      range_high REAL,
      recurring INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS income_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      net_amount REAL,
      pay_date TEXT NOT NULL,
      pay_type TEXT NOT NULL DEFAULT 'regular',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS fund_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      income_entry_id INTEGER,
      target_account TEXT NOT NULL,
      amount REAL NOT NULL,
      allocated_date TEXT NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (income_entry_id) REFERENCES income_entries(id)
    );

    CREATE TABLE IF NOT EXISTS savings_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target_amount REAL NOT NULL,
      current_amount REAL NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 5,
      target_date TEXT,
      created_by INTEGER NOT NULL,
      is_joint INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS levers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      lever_type TEXT NOT NULL,
      value REAL NOT NULL DEFAULT 0,
      set_by INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (set_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS account_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_type TEXT NOT NULL,
      balance REAL NOT NULL,
      updated_by INTEGER NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (updated_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS claude_advice (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      advice_type TEXT NOT NULL,
      content TEXT NOT NULL,
      context_data TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS upcoming_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      estimated_amount REAL NOT NULL,
      expected_date TEXT NOT NULL,
      category TEXT,
      notes TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS weekly_checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      checkin_date TEXT NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // Auto-seed default users if none exist
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    console.log('No users found, seeding defaults...');
    const hash1 = bcrypt.hashSync('GoPies2023', 10);
    const hash2 = bcrypt.hashSync('GoPies2023', 10);
    const insertUser = db.prepare(
      'INSERT INTO users (username, display_name, password_hash, role, gross_income, super_rate, hecs_repayment_rate, pay_cycle) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    insertUser.run('adam', 'Adam', hash1, 'primary', 159000, 0.115, 0.06, 'fortnightly');
    insertUser.run('aruto', 'Aruto', hash2, 'partner', 70000, 0.115, 0.04, 'weekly');

    const user1 = db.prepare('SELECT id FROM users WHERE username = ?').get('adam');
    if (user1) {
      db.prepare('INSERT INTO account_balances (account_type, balance, updated_by) VALUES (?, ?, ?)').run('offset', 57000, user1.id);
      db.prepare('INSERT INTO account_balances (account_type, balance, updated_by) VALUES (?, ?, ?)').run('savings', 0, user1.id);
      db.prepare('INSERT INTO account_balances (account_type, balance, updated_by) VALUES (?, ?, ?)').run('credit_card', 0, user1.id);
      db.prepare('INSERT INTO account_balances (account_type, balance, updated_by) VALUES (?, ?, ?)').run('investment', 0, user1.id);
    }
    console.log('Default users seeded: adam, aruto');
  }
}

module.exports = { getDb };
