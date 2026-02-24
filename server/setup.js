require('dotenv').config();
const { getDb } = require('./db');
const bcrypt = require('bcryptjs');

const db = getDb();

const hash1 = bcrypt.hashSync('GoPies2023', 10);
const hash2 = bcrypt.hashSync('GoPies2023', 10);

// Create default users
const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users (username, display_name, password_hash, role, gross_income, super_rate, hecs_repayment_rate, pay_cycle)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

insertUser.run('adam', 'Adam', hash1, 'primary', 159000, 0.115, 0.06, 'fortnightly');
insertUser.run('aruto', 'Aruto', hash2, 'partner', 70000, 0.115, 0.04, 'weekly');

// Set initial offset account balance
const insertBalance = db.prepare(`
  INSERT INTO account_balances (account_type, balance, updated_by)
  VALUES (?, ?, ?)
`);

const user1 = db.prepare('SELECT id FROM users WHERE username = ?').get('adam');
if (user1) {
  insertBalance.run('offset', 57000, user1.id);
  insertBalance.run('savings', 0, user1.id);
  insertBalance.run('credit_card', 0, user1.id);
  insertBalance.run('investment', 0, user1.id);
}

// Create default savings goals
const insertGoal = db.prepare(`
  INSERT INTO savings_goals (name, target_amount, current_amount, priority, target_date, created_by, is_joint)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

if (user1) {
  insertGoal.run('Emergency Fund', 30000, 0, 1, '2027-01-01', user1.id, 1);
  insertGoal.run('Offset Account Growth', 100000, 57000, 2, '2028-06-01', user1.id, 1);
  insertGoal.run('Holiday Fund', 5000, 0, 3, '2026-12-01', user1.id, 1);
}

// Create default levers
const insertLever = db.prepare(`
  INSERT INTO levers (name, description, lever_type, value, set_by)
  VALUES (?, ?, ?, ?, ?)
`);

if (user1) {
  insertLever.run('Offset Priority %', 'Percentage of surplus directed to offset account', 'percentage', 50, user1.id);
  insertLever.run('Savings Priority %', 'Percentage of surplus directed to savings', 'percentage', 30, user1.id);
  insertLever.run('Investment Priority %', 'Percentage of surplus directed to investments', 'percentage', 10, user1.id);
  insertLever.run('Fun Money %', 'Percentage of surplus for discretionary spending', 'percentage', 10, user1.id);
  insertLever.run('Weekly Grocery Budget', 'Target weekly grocery spend', 'dollar', 250, user1.id);
  insertLever.run('Weekly Dining Out Budget', 'Target weekly dining out spend', 'dollar', 80, user1.id);
}

console.log('Setup complete! Default users created:');
console.log('  adam / GoPies2023 (Primary - $159k, fortnightly)');
console.log('  aruto / GoPies2023 (Partner - $70k, weekly)');
console.log('  Offset account set to $57,000');
console.log('  Default savings goals and levers created');
