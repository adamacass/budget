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

    CREATE TABLE IF NOT EXISTS category_budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT UNIQUE NOT NULL,
      monthly_amount REAL NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS deleted_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT,
      amount REAL,
      expense_date TEXT,
      user_id INTEGER,
      deleted_at TEXT DEFAULT (datetime('now')),
      UNIQUE(description, amount, expense_date, user_id)
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

      // Seed default levers
      const insertLever = db.prepare('INSERT INTO levers (name, description, lever_type, value, set_by) VALUES (?, ?, ?, ?, ?)');
      insertLever.run('Offset Account %', 'Percentage of surplus allocated to offset account', 'percentage', 50, user1.id);
      insertLever.run('Savings %', 'Percentage of surplus allocated to savings', 'percentage', 30, user1.id);
      insertLever.run('Investment %', 'Percentage of surplus allocated to investments', 'percentage', 10, user1.id);
      insertLever.run('Budget Scale %', 'Scale all category budgets (100 = conservative base, 120 = 20% more spending room, 80 = tighter)', 'percentage', 100, user1.id);
      console.log('Default levers seeded');
    }
    console.log('Default users seeded: adam, aruto');
  }

  // Seed actual bank statement data if expenses table is empty
  const expenseCount = db.prepare('SELECT COUNT(*) as count FROM expenses').get().count;
  if (expenseCount === 0) {
    seedStatementData();
  }

  // Seed category budgets if none exist (conservative / high-savings baseline)
  const budgetCount = db.prepare('SELECT COUNT(*) as count FROM category_budgets').get().count;
  if (budgetCount === 0) {
    const insertBudget = db.prepare('INSERT INTO category_budgets (category, monthly_amount) VALUES (?, ?)');
    const conservativeBudgets = [
      ['Groceries', 800], ['Dining Out', 200], ['Transport', 200],
      ['Utilities', 250], ['Insurance', 200], ['Entertainment', 100],
      ['Health', 100], ['Clothing', 80], ['Personal Care', 60],
      ['Subscriptions', 50], ['Pets', 50], ['Gifts', 50],
      ['Education', 50], ['Home', 100], ['Other', 100]
    ];
    for (const [cat, amt] of conservativeBudgets) {
      insertBudget.run(cat, amt);
    }
    console.log('Category budgets seeded (conservative / high-savings): $' + conservativeBudgets.reduce((s, b) => s + b[1], 0) + '/mo');
  }
}

function autoCategorizeTxn(desc) {
  const d = desc.toLowerCase();
  if (/woolworths|coles|aldi|iga|harris farm|market|grocer|fruit|butcher|bakers delight|pasture/.test(d)) return 'Groceries';
  if (/uber\s?eats|doordash|menulog|deliveroo|mcdonald|kfc|subway|pizza|burger|cafe|coffee|restaurant|bar\s|pub\s|tavern|dining|eat|brunch|lunch|sushi|thai|greek|chinese|banh mi|crepe|roast|grill|souvla|rooster|boost juice|rowers|cellars|liquorland|surf club|canteen|noodles|janus bar|artistry garden/.test(d)) return 'Dining Out';
  if (/uber|lyft|taxi|cabcharge|opal|linkt|toll|parking|fuel|petrol|bp\s|shell|caltex|ampol|7-?eleven|rego|rms|nrma|car\s?wash|transportfornsw|taxipay|syd aprt|carp50/.test(d)) return 'Transport';
  if (/energy|water|gas|telstra|optus|vodafone|tpg|iinet|internet|broadband|electricity|ausgrid|origin|agl|sydney water|bpay.*water/.test(d)) return 'Utilities';
  if (/insurance|allianz|qbe|suncorp|nib|medibank|bupa|hcf|ahm/.test(d)) return 'Insurance';
  if (/netflix|spotify|disney|stan|binge|kayo|apple\.com|youtube|amazon prime|amznprime|subscribe|membership|patreon|noahpinion|readtheclassics|kindle|fairfax|google one|openai|chatgpt|claude\.ai|anthropic|sam harris/.test(d)) return 'Subscriptions';
  if (/cinema|movies|ticket|event|concert|sport|game|bowling|golf|tennis|museum|zoo|theme park|luna park|steam|steamgames|ticketmaster|ticketek|united cup|sunrun/.test(d)) return 'Entertainment';
  if (/pharmacy|chemist|doctor|gp\s|medical|dental|dentist|physio|gym|fitness|pool|yoga|pilates|health|fitness first/.test(d)) return 'Health';
  if (/kmart|target|uniqlo|zara|h&m|cotton on|country road|myer|david jones|clothes|fashion|shoe|universal store|rebel|institchu|mens biz/.test(d)) return 'Clothing';
  if (/hair|barber|beauty|nail|skin|spa|cosmetic|makeup|shav|fade out/.test(d)) return 'Personal Care';
  if (/pet|vet|petbarn|petsmart|pet circle|animal/.test(d)) return 'Pets';
  if (/gift|flower|present|hamper|salvation army|gofundme/.test(d)) return 'Gifts';
  if (/course|book|udemy|education|tutor|uni|school|tafe|dymocks/.test(d)) return 'Education';
  if (/bunnings|ikea|officeworks|furniture|homeware|hardware|garden|plumb|electr|temple.*webster|mocka|ruggable|bed bath|kogan|supercheap auto|chuck trailer/.test(d)) return 'Home';
  if (/international transaction fee/.test(d)) return 'Other';
  if (/bpay.*deft|bpay.*payment|mortgage/.test(d)) return 'Mortgage';
  return 'Other';
}

function seedStatementData() {
  const primaryUser = db.prepare('SELECT id FROM users WHERE role = ? OR username = ?').get('primary', 'adam');
  if (!primaryUser) return;
  const userId = primaryUser.id;

  // Actual credit card statement transactions (Dec 2025 - Feb 2026)
  const transactions = [
    ['16/12/25', 'McDonalds International Mascot NSW', 8.50],
    ['16/12/25', 'Cocacolaepp Mascot Aus', 4.50],
    ['16/12/25', 'Syd Aprt Intnl Carp50 Sydney NSW', 24.42],
    ['17/12/25', 'Fairfax Subscriptions Pyrmont Aus', 64.99],
    ['17/12/25', 'J And K Capital Invest Sydney Aus', 11.90],
    ['17/12/25', 'Zlr*Bomonti Cafe Sydney Aus', 5.36],
    ['17/12/25', 'Transportfornsw Tap Sydney Aus', 31.95],
    ['18/12/25', 'Chambers Coffee Gatew Sydney NSW', 18.01],
    ['18/12/25', 'Uber *Eats Help.Uber.C Sydney Aus', 31.70],
    ['18/12/25', 'Dbs*Fitness First Pitt Sydney NSW', 42.99],
    ['18/12/25', 'Transportfornsw Tap Sydney Aus', 17.30],
    ['19/12/25', 'Edition Roasters Mc Sydney NSW', 5.50],
    ['19/12/25', 'Sushi N Plus Pty Ltd Sydney Aus', 16.09],
    ['19/12/25', 'Transportfornsw Tap Sydney Aus', 3.66],
    ['20/12/25', 'Best Fruit At Mosman Mosman NSW', 17.22],
    ['20/12/25', 'Mosman Cali Press Mosman NSW', 17.15],
    ['20/12/25', 'Bakers Delight Mosman Aus', 17.40],
    ['20/12/25', 'Ww Metro 8533 Mosman Ns', 74.48],
    ['20/12/25', 'Bed Bath N Table Mosman NSW', 101.60],
    ['20/12/25', 'The Salvation Army Blackburn VIC', 20.00],
    ['20/12/25', 'Iga Mosman Mosman NSW', 4.00],
    ['21/12/25', 'Watermark Mascot NSW', 51.23],
    ['21/12/25', 'Relay Mascot NSW', 6.07],
    ['21/12/25', 'Readtheclassics London Eng', 11.00],
    ['22/12/25', 'Transportfornsw Tap Sydney Aus', 17.92],
    ['22/12/25', 'Noahpinion San Francisco Ca', 16.00],
    ['23/12/25', 'Ls Like Minded Co Pty Moffat Beach Aus', 12.62],
    ['23/12/25', 'Universal Store Maroochydore QLD', 119.99],
    ['23/12/25', 'Jb Hi Fi Maroochydore QLD', 279.00],
    ['23/12/25', 'Liquorland 6688 Currimundi Aus', 46.00],
    ['23/12/25', 'Myer Maroochydore Maroochydore QLD', 94.00],
    ['23/12/25', 'Woolworths 2624 Currimundi Aus', 83.57],
    ['24/12/25', 'Ccssm Pty Ltd Caloundra QLD', 60.00],
    ['24/12/25', 'Bookshop At Caloundra Caloundra QLD', 23.19],
    ['25/12/25', 'Sophie Corks Orange NSW', 885.00],
    ['28/12/25', 'Apple.Com/Bill Sydney NSW', 15.99],
    ['29/12/25', 'Dbs*Fitness First Pitt Sydney NSW', 42.99],
    ['24/12/25', 'Red Rooster Currimun Currimundi Aus', 9.95],
    ['24/12/25', 'Caloundra Surf Club Caloundra Aus', 7.00],
    ['29/12/25', 'Woolworths 2624 Currimundi Aus', 42.16],
    ['01/01/26', 'Ls The Sanctuary Cafe Dicky Beach Aus', 23.74],
    ['01/01/26', 'Iga Local Grocer Dickybeach Aus', 8.49],
    ['02/01/26', 'Dbs*Fitness First Pitt Sydney NSW', 9.99],
    ['02/01/26', 'Dbs*Fitness First Pitt Sydney NSW', 42.99],
    ['02/01/26', 'Boost Juice Kawana Buddina QLD', 11.30],
    ['02/01/26', 'Big W 0256 Buddina Aus', 16.00],
    ['01/01/26', 'McDonalds Virginia Virginia QLD', 26.70],
    ['03/01/26', 'Woolworths 2624 Currimundi Aus', 71.31],
    ['03/01/26', 'Steamgames.Com 4259522 Bellevue WA', 7.37],
    ['04/01/26', 'Amazon Au Marketplace Sydney Aus', 12.99],
    ['05/01/26', 'Mobile BPAY Deft Payments', 1339.61],
    ['06/01/26', 'Churches Of Christ Meridan Plain QLD', 6.90],
    ['07/01/26', 'The Pocket Espresso Moffat Beach QLD', 7.12],
    ['07/01/26', 'Woolworths 2624 Currimundi Aus', 54.56],
    ['07/01/26', 'Sp Jonesandco1 Waterloo NSW', 165.00],
    ['07/01/26', 'Churches Of Christ Meridan Plain QLD', 6.90],
    ['07/01/26', 'Google One Barangaroo Aus', 2.99],
    ['07/01/26', 'Temple & Webster 1300900675 Aus', 290.93],
    ['07/01/26', 'Sp Mocka Australia Pinkenba QLD', 301.98],
    ['07/01/26', 'Sp Ruggable Australia Sydney NSW', 379.00],
    ['08/01/26', 'Dbs*Fitness First Pitt Sydney NSW', 42.99],
    ['08/01/26', 'Kindle Svcs Melbourne Aus', 13.99],
    ['07/01/26', 'Red Rooster Currimun Currimundi Aus', 9.95],
    ['08/01/26', 'Amazon Au Marketplace Sydney Aus', 37.95],
    ['08/01/26', 'Apple.Com/Bill Sydney Aus', 2.99],
    ['09/01/26', 'Kogan.Com Yj94eljn Melbourne Aus', 258.00],
    ['08/01/26', 'Tm *Ticketmasterau Melbourne Aus', 390.00],
    ['09/01/26', 'Amznprimea* Amznprimea Sydney South NSW', 9.99],
    ['09/01/26', 'Disney Plus Richmond Aus', 15.99],
    ['09/01/26', 'Timeleft Subscription Paris Ile', 23.99],
    ['10/01/26', 'Patreon* Membership Internet Irl', 9.35],
    ['10/01/26', 'Sunrun2026 Dee Why NSW', 70.00],
    ['10/01/26', 'Ww Metro 8533 Mosman Ns', 56.28],
    ['11/01/26', 'Sq *Proudly Supporting Roseville Ns', 3.50],
    ['11/01/26', 'Sq *United Cup Retail_ Silverwater Ns', 19.30],
    ['11/01/26', 'Ezymart Central Stn Haymarket NSW', 11.69],
    ['11/01/26', 'Sq *The Coffee Box Cir Sydney Ns', 8.39],
    ['11/01/26', 'Pasture Of Balmoral Mosman Aus', 6.79],
    ['11/01/26', 'Sq *United Cup Retail_ Silverwater Ns', 18.00],
    ['11/01/26', 'Transportfornsw Tap Sydney Aus', 27.57],
    ['11/01/26', 'Bunnings 757000 Chatswood Aus', 227.31],
    ['11/01/26', 'Bunnings 757000 Chatswood Aus', 122.58],
    ['11/01/26', 'Apple.Com/Bill Sydney Aus', 4.49],
    ['11/01/26', 'Sq *Cafe Monstera Cremorne Poin Ns', 6.11],
    ['11/01/26', 'Sam Harris Media Llc Encino Ca', 99.07],
    ['11/01/26', 'International Transaction Fee', 3.47],
    ['09/01/26', 'Cocacolaepp Marcoola Aus', 4.50],
    ['12/01/26', 'Syd Aprt Intnl Carp50 Sydney NSW', 24.42],
    ['12/01/26', 'Veloce International Mascot Aus', 6.61],
    ['12/01/26', 'Whsmith Sydt1 Arrival1 Mascot Aus', 4.05],
    ['12/01/26', 'Transportfornsw Tap Sydney Aus', 9.65],
    ['12/01/26', 'Tong Li Supermarket Hornsby Aus', 69.90],
    ['13/01/26', 'Spe*Institchu Avalon Aus', 602.62],
    ['13/01/26', 'Spe*Institchu Avalon Aus', 419.52],
    ['13/01/26', 'Gang Thai Sydney NSW', 47.55],
    ['13/01/26', 'Healthline Pharmacy Sydney NSW', 48.47],
    ['14/01/26', 'Ww Metro 8533 Mosman Ns', 66.11],
    ['14/01/26', 'Transportfornsw Tap Sydney Aus', 15.01],
    ['14/01/26', 'Apple.Com/Bill Sydney NSW', 25.99],
    ['15/01/26', 'Dbs*Fitness First Pitt Sydney NSW', 42.99],
    ['15/01/26', 'Sq *Cat With Ball Of Y Rhodes Ns', 35.00],
    ['15/01/26', 'Transportfornsw Tap Sydney Aus', 4.62],
    ['16/01/26', 'Dymocks Chatswood Chatswood Aus', 87.15],
    ['16/01/26', 'Rebel Chatswood Chatswood NSW', 100.00],
    ['16/01/26', 'Myer Chatswood Chatswood NSW', 149.00],
    ['16/01/26', 'Coles 0852 Chatswood Aus', 19.75],
    ['16/01/26', 'Openai *Chatgpt Subscr San Francisco Ca', 33.01],
    ['16/01/26', 'International Transaction Fee', 1.16],
    ['17/01/26', 'The Little French Pati Mosman Aus', 4.76],
    ['16/01/26', 'Bp Mosman South 9542 Mosman NSW', 137.47],
    ['17/01/26', 'Avoca Beach Bowling Avoca Beach Aus', 25.60],
    ['17/01/26', 'Orang Tuah Pty Ltd Avoca Beach Aus', 86.40],
    ['17/01/26', 'Avoca Beach Bowling Avoca Beach Aus', 10.00],
    ['18/01/26', 'Ww Metro 8533 Mosman Ns', 48.21],
    ['19/01/26', 'Edition Roasters Mc Sydney NSW', 5.00],
    ['16/01/26', 'Plineph Chatswood Chatswood Aus', 26.00],
    ['17/01/26', 'Fairfax Subscriptions Pyrmont Aus', 64.99],
    ['19/01/26', 'Post Sydney Gpo Post S Sydney Aus', 25.80],
    ['19/01/26', 'Locali By Romeos Sydney NSW', 12.49],
    ['20/01/26', 'The Coffee Emporium C Sydney NSW', 5.08],
    ['20/01/26', 'Transportfornsw Tap Sydney Aus', 17.30],
    ['20/01/26', 'J And K Capital Invest Sydney Aus', 10.50],
    ['20/01/26', 'Juju Store Pty Ltd Sydney NSW', 4.03],
    ['21/01/26', 'Anthropic San Francisco Ca', 22.00],
    ['21/01/26', 'International Transaction Fee', 0.77],
    ['21/01/26', 'Anthropic San Francisco Ca', 5.50],
    ['21/01/26', 'International Transaction Fee', 0.19],
    ['21/01/26', 'Anthropic San Francisco Ca', 22.00],
    ['21/01/26', 'International Transaction Fee', 0.77],
    ['21/01/26', 'Readtheclassics London Eng', 11.00],
    ['21/01/26', 'International Transaction Fee', 0.39],
    ['21/01/26', 'Transportfornsw Tap Sydney Aus', 16.31],
    ['21/01/26', 'Claude.Ai Subscription San Francisco Ca', 34.00],
    ['21/01/26', 'International Transaction Fee', 1.19],
    ['22/01/26', 'Dbs*Fitness First Pitt Sydney NSW', 42.99],
    ['22/01/26', 'Www.P48.Com.Au Belrose NSW', 200.00],
    ['22/01/26', 'Anthropic San Francisco Ca', 11.00],
    ['22/01/26', 'International Transaction Fee', 0.39],
    ['22/01/26', 'Anthropic San Francisco Ca', 5.50],
    ['22/01/26', 'International Transaction Fee', 0.19],
    ['22/01/26', 'Noahpinion San Francisco Ca', 16.00],
    ['22/01/26', 'International Transaction Fee', 0.56],
    ['22/01/26', 'Anthropic San Francisco Ca', 11.00],
    ['22/01/26', 'International Transaction Fee', 0.39],
    ['22/01/26', 'Anthropic San Francisco Ca', 5.50],
    ['22/01/26', 'International Transaction Fee', 0.19],
    ['23/01/26', 'Uniqlo Australia Pty L Melbourne Aus', 131.80],
    ['23/01/26', 'Ww Metro 1211 Sydney Ns', 5.20],
    ['23/01/26', 'Edition Roasters Mc Sydney NSW', 5.50],
    ['23/01/26', 'The August Banh Mi P Sydney NSW', 13.00],
    ['23/01/26', 'Coles 4974 Neutral Bay Aus', 41.15],
    ['23/01/26', 'Anthropic San Francisco Ca', 16.50],
    ['23/01/26', 'International Transaction Fee', 0.58],
    ['24/01/26', 'The Boathouse Balmoral Sydney NSW', 33.56],
    ['24/01/26', 'Coles 0829 Neutral Bay Aus', 67.85],
    ['24/01/26', 'Transportfornsw Tap Sydney Aus', 9.65],
    ['24/01/26', 'Mosman Municapl Coun Mosman Aus', 16.00],
    ['24/01/26', 'Little Island Hungry S Mosman Aus', 11.67],
    ['25/01/26', 'Pasture Of Balmoral Mosman Aus', 14.70],
    ['25/01/26', 'Transportfornsw Tap Sydney Aus', 6.74],
    ['25/01/26', 'Steam Purchase Seattle Deu', 36.50],
    ['25/01/26', 'International Transaction Fee', 1.28],
    ['26/01/26', 'Fourth Village Provid Mosman NSW', 5.95],
    ['27/01/26', 'Edition Roasters Mc Sydney NSW', 5.00],
    ['27/01/26', 'Ww Metro 1211 Sydney Ns', 4.00],
    ['24/01/26', 'Exquisite Dining Pl Haymarket NSW', 125.66],
    ['27/01/26', 'Supercheap Auto Strathpine QLD', 50.00],
    ['27/01/26', 'Sushi N Plus Pty Ltd Sydney Aus', 17.10],
    ['27/01/26', 'Sq *Chaos Cafe Mosman Mosman Ns', 11.18],
    ['28/01/26', 'Transportfornsw Tap Sydney Aus', 17.30],
    ['28/01/26', 'Gecal Scp Pty Ltd Sydney Aus', 17.12],
    ['29/01/26', 'Ww Metro 1211 Sydney Ns', 9.50],
    ['29/01/26', 'Dbs*Fitness First Pitt Sydney NSW', 42.99],
    ['29/01/26', 'Transportfornsw Tap Sydney Aus', 16.31],
    ['29/01/26', 'Sushi N Plus Pty Ltd Sydney Aus', 9.61],
    ['30/01/26', 'Edition Roasters Mc Sydney NSW', 5.50],
    ['30/01/26', 'Boonoona Siteminder 2 Crows Nest NSW', 946.28],
    ['30/01/26', 'Coles 7689 Sydney Aus', 11.00],
    ['30/01/26', 'Sq *Prefecture 48 Sydney Ns', 470.40],
    ['30/01/26', 'Transportfornsw Tap Sydney Aus', 16.39],
    ['30/01/26', 'Dymocks Sydney Qps Sydney Aus', 33.28],
    ['30/01/26', 'Mitchells King Sydney NSW', 14.95],
    ['31/01/26', 'Max Brenner Australia Manly Aus', 5.56],
    ['31/01/26', 'Anthropic San Francisco Ca', 7.89],
    ['31/01/26', 'International Transaction Fee', 0.28],
    ['31/01/26', 'Sq *Piccolo Cafe Balmain Ns', 11.18],
    ['01/02/26', 'Austrian Club Restaur Frenchs Fores NSW', 70.47],
    ['01/02/26', 'Austrian Club Sydney Frenchs Fores Aus', 15.00],
    ['02/02/26', 'Edition Roasters Mc Sydney NSW', 5.50],
    ['02/02/26', 'Iga Quay Quarter Sydney Aus', 45.31],
    ['02/02/26', 'J And K Capital Invest Sydney Aus', 13.90],
    ['02/02/26', 'Superb Sunny Pty Ltd Sydney Aus', 8.48],
    ['03/02/26', 'Zeus Street Greek - W Sydney NSW', 16.19],
    ['03/02/26', 'Edition Roasters Mc Sydney NSW', 5.50],
    ['03/02/26', 'Transportfornsw Tap Sydney Aus', 17.30],
    ['04/02/26', 'Mens Biz Sydney Sydney Aus', 60.90],
    ['04/02/26', 'Ww Metro 1211 Sydney Ns', 10.00],
    ['04/02/26', 'Transportfornsw Tap Sydney Aus', 19.30],
    ['04/02/26', 'Superb Sunny Pty Ltd Sydney Aus', 8.48],
    ['05/02/26', 'Dbs*Fitness First Pitt Sydney NSW', 42.99],
    ['05/02/26', 'Ww Metro 8533 Mosman Ns', 58.85],
    ['05/02/26', 'Transportfornsw Tap Sydney Aus', 13.40],
    ['05/02/26', 'Amazon Au Marketplace Sydney Aus', 149.99],
    ['05/02/26', 'Claude.Ai Subscription San Francisco Ca', 152.79],
    ['05/02/26', 'International Transaction Fee', 5.35],
    ['06/02/26', 'Ww Metro 1211 Sydney Ns', 10.65],
    ['06/02/26', 'Chuck Trailers Sydney NSW', 69.11],
    ['06/02/26', 'Chuck Trailers Sydney NSW', 39.63],
    ['07/02/26', 'Google One Pyrmont Aus', 2.99],
    ['08/02/26', 'Sq *Goodbars Au Wentworthvill Ns', 23.76],
    ['08/02/26', 'Sq *Goodbars Au Wentworthvill Ns', 31.34],
    ['08/02/26', 'Sq *Goodbars Au Wentworthvill Ns', 31.34],
    ['09/02/26', 'Edition Roasters Mc Sydney NSW', 5.50],
    ['09/02/26', 'Amznprimea* Amznprimea Sydney South NSW', 9.99],
    ['09/02/26', 'Little Chinese Kitchen Sydney Aus', 12.13],
    ['09/02/26', 'Superb Sunny Pty Ltd Sydney Aus', 8.48],
    ['09/02/26', 'Disney Plus Richmond Aus', 15.99],
    ['10/02/26', 'Edition Roasters Mc Sydney NSW', 6.00],
    ['10/02/26', 'Zeus Street Greek - W Sydney NSW', 15.17],
    ['10/02/26', 'Patreon* Membership Internet Irl', 9.35],
    ['10/02/26', 'International Transaction Fee', 0.33],
    ['10/02/26', 'Ww Metro 1211 Sydney Ns', 4.80],
    ['10/02/26', 'Iga Quay Quarter Sydney Aus', 31.79],
    ['10/02/26', 'Transportfornsw Tap Sydney Aus', 17.30],
    ['11/02/26', 'Ww Metro 1211 Sydney Ns', 7.95],
    ['11/02/26', 'Lkf Ventures Pty Ltd Circular Quay NSW', 13.13],
    ['10/02/26', 'Dnh*Godaddy#4013847659 Sydney Aus', 87.77],
    ['11/02/26', 'J And K Capital Invest Sydney Aus', 10.50],
    ['11/02/26', 'Transportfornsw Tap Sydney Aus', 11.99],
    ['11/02/26', 'Apple.Com/Bill Sydney Aus', 4.49],
    ['12/02/26', 'Ww Metro 1211 Sydney Ns', 14.00],
    ['12/02/26', 'Dbs*Fitness First Pitt Sydney NSW', 42.99],
    ['12/02/26', 'Edition Roasters Mc Sydney NSW', 6.50],
    ['12/02/26', 'Sq *Cafe Monstera Point Piper Ns', 6.11],
    ['12/02/26', 'Sq *Cafe Monstera Point Piper Ns', 7.13],
    ['12/02/26', 'Amazon Au Retail Sydney Aus', 77.00],
    ['12/02/26', 'Amazon Au Marketplace Sydney Aus', 19.98],
    ['12/02/26', 'Transportfornsw Tap Sydney Aus', 17.30],
    ['12/02/26', 'McDonalds Sydney Gat Sydney NSW', 8.45],
    ['13/02/26', 'Gecal Scp Pty Ltd Sydney Aus', 13.25],
    ['13/02/26', 'Transportfornsw Tap Sydney Aus', 3.41],
    ['14/02/26', 'Ls Four Frogs Creperie Mosman Aus', 65.76],
    ['14/02/26', 'Best Fruit At Mosman Mosman NSW', 15.23],
    ['14/02/26', 'Apple.Com/Bill Sydney NSW', 25.99],
    ['14/02/26', 'Bathers Restaurant Mosman Aus', 441.22],
    ['15/02/26', "Sq *Hamilton's Hospita Strathfield S Ns", 6.00],
    ['14/02/26', 'Iga Mosman Mosman NSW', 59.94],
    ['15/02/26', 'Anthropic San Francisco Ca', 39.06],
    ['15/02/26', 'International Transaction Fee', 1.37],
    ['15/02/26', 'Lambda Souvla Grill Punchbowl Aus', 22.55],
    ['16/02/26', 'Mobile BPAY Sydney Water', 205.95],
    ['16/02/26', 'Netoo Store Pty Ltd Sydney NSW', 7.14],
    ['14/02/26', 'Taxipay Australia Mascot NSW', 52.50],
    ['16/02/26', "Sq *Capp Espresso O'Co Sydney Ns", 7.09],
    // Feb 17-21 2026
    ['17/02/26', 'Iga Plus Liquor Quay Quarter Sydney', 11.41],
    ['17/02/26', 'Cafe Clutz Clayton Utz Sydney', 8.00],
    ['17/02/26', 'Fairfax Subscriptions Pyrmont Aus', 64.99],
    ['17/02/26', 'Transportfornsw Tap Sydney Aus', 14.70],
    ['17/02/26', 'Interest Charged', 31.13],
    ['18/02/26', 'Netoo Store Pty Ltd Sydney NSW', 4.08],
    ['18/02/26', 'Transportfornsw Tap Sydney Aus', 14.70],
    ['18/02/26', 'Dbs*Fitness First Pitt Sydney NSW', 42.99],
    ['19/02/26', 'Skittle Lane Circular Quay Sydney', 6.59],
    ['19/02/26', 'Transportfornsw Tap Sydney Aus', 14.70],
    ['19/02/26', 'Mosman Rowers Mosman NSW', 12.13],
    ['19/02/26', 'Mosman Rowers Mosman NSW', 28.31],
    ['19/02/26', 'Netoo Store Pty Ltd Sydney NSW', 8.17],
    ['20/02/26', 'Amazon Au Marketplace Sydney Aus', 27.99],
    ['20/02/26', 'Vintage Cellars Neutral Bay Junction', 66.00],
    ['20/02/26', 'Coles Neutral Bay Grosvenor St', 62.35],
    ['20/02/26', 'Amazon Au Marketplace Sydney Aus', 62.99],
    ['20/02/26', 'Transportfornsw Tap Sydney Aus', 5.90],
    ['21/02/26', 'Aldi Mosman Mosman NSW', 11.92],
    ['21/02/26', 'International Transaction Fee', 0.39],
    ['21/02/26', 'Readtheclassics London Eng', 11.00],
    ['21/02/26', 'Harris Farm Markets Bridgepoint', 139.83],
    ['21/02/26', 'Chambers Cellars Mosman NSW', 23.99],
    // Feb 22-27 2026
    ['22/02/26', 'Noahpinion San Francisco Ca', 16.00],
    ['22/02/26', 'Skittle Lane Circular Quay Sydney', 6.59],
    ['22/02/26', 'International Transaction Fee', 0.56],
    ['23/02/26', 'Artistry Garden Sydney NSW', 5.07],
    ['24/02/26', 'Netoo Store Pty Ltd Sydney NSW', 12.76],
    ['24/02/26', 'International Transaction Fee', 1.37],
    ['24/02/26', 'Square Sydney Aus', 5.58],
    ['24/02/26', 'Transportfornsw Tap Sydney Aus', 14.70],
    ['24/02/26', 'Anthropic San Francisco Ca', 39.03],
    ['24/02/26', 'GoFundMe San Diego Ca', 100.00],
    ['24/02/26', 'Netoo Store Pty Ltd Sydney NSW', 9.19],
    ['25/02/26', 'Dbs*Fitness First Pitt Sydney NSW', 42.99],
    ['25/02/26', 'Iga Plus Liquor Quay Quarter Sydney', 61.13],
    ['25/02/26', 'Transportfornsw Tap Sydney Aus', 14.70],
    ['25/02/26', 'Cafe Clutz Clayton Utz Sydney', 6.00],
    ['26/02/26', 'Netoo Store Pty Ltd Sydney NSW', 11.22],
    ['26/02/26', 'Transportfornsw Tap Sydney Aus', 14.70],
    ['26/02/26', 'CBD Noodles Sydney NSW', 19.73],
    ['26/02/26', 'Cafe Clutz Clayton Utz Sydney', 2.80],
    ['26/02/26', 'Janus Bar Sydney NSW', 5.28],
    ['27/02/26', 'This Way Canteen Sydney NSW', 16.48],
    // Feb 28 - Mar 1 2026
    ['28/02/26', 'Ticketek Sydney NSW', 408.70],
    ['01/03/26', 'Ww Metro 8533 Mosman Ns', 30.00],
    ['01/03/26', 'Sushi Connection Mosman NSW', 16.50],
    ['01/03/26', 'Ritchies Supa Iga Bridgepoint Mosman NSW', 56.89],
    ['01/03/26', 'Fade Out Barbershop Sydney NSW', 35.00],
  ];

  function parseDate(dateStr) {
    const [day, month, year] = dateStr.split('/');
    const fullYear = parseInt(year) < 50 ? `20${year}` : `19${year}`;
    return `${fullYear}-${month}-${day}`;
  }

  const insert = db.prepare(
    'INSERT INTO expenses (user_id, category, description, amount, expense_date, entry_type, recurring) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  const seedAll = db.transaction(() => {
    for (const [dateStr, desc, amount] of transactions) {
      const date = parseDate(dateStr);
      const category = autoCategorizeTxn(desc);
      insert.run(userId, category, desc, amount, date, 'actual', 0);
    }
  });
  seedAll();
  console.log(`Seeded ${transactions.length} bank statement transactions`);

  // Seed savings goals if none exist
  const goalCount = db.prepare('SELECT COUNT(*) as count FROM savings_goals').get().count;
  if (goalCount === 0) {
    db.prepare(
      'INSERT INTO savings_goals (name, target_amount, current_amount, priority, target_date, created_by, is_joint, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('Emergency Fund', 20000, 5700, 1, '2026-12-31', userId, 1, 1);
    db.prepare(
      'INSERT INTO savings_goals (name, target_amount, current_amount, priority, target_date, created_by, is_joint, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('Holiday Fund', 5000, 1200, 3, '2026-10-01', userId, 1, 1);
    console.log('Seeded savings goals');
  }
}

module.exports = { getDb, autoCategorizeTxn };
