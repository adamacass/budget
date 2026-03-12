const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// Use DATABASE_URL for PostgreSQL connection (Render sets this automatically)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

let initialized = false;

async function getDb() {
  if (!initialized) {
    await initSchema();
    initialized = true;
    console.log('PostgreSQL database initialized');
  }
  return pool;
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'partner',
      gross_income REAL NOT NULL DEFAULT 0,
      super_rate REAL NOT NULL DEFAULT 0.115,
      hecs_repayment_rate REAL NOT NULL DEFAULT 0,
      pay_cycle TEXT NOT NULL DEFAULT 'fortnightly',
      mortgage_contribution REAL NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
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
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS income_entries (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount REAL NOT NULL,
      net_amount REAL,
      pay_date TEXT NOT NULL,
      pay_type TEXT NOT NULL DEFAULT 'regular',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS fund_allocations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      income_entry_id INTEGER REFERENCES income_entries(id),
      target_account TEXT NOT NULL,
      amount REAL NOT NULL,
      allocated_date TEXT NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS savings_goals (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      target_amount REAL NOT NULL,
      current_amount REAL NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 5,
      target_date TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      is_joint INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS levers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      lever_type TEXT NOT NULL,
      value REAL NOT NULL DEFAULT 0,
      set_by INTEGER NOT NULL REFERENCES users(id),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS account_balances (
      id SERIAL PRIMARY KEY,
      account_type TEXT NOT NULL,
      balance REAL NOT NULL,
      updated_by INTEGER NOT NULL REFERENCES users(id),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS claude_advice (
      id SERIAL PRIMARY KEY,
      advice_type TEXT NOT NULL,
      content TEXT NOT NULL,
      context_data TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS upcoming_expenses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      description TEXT NOT NULL,
      estimated_amount REAL NOT NULL,
      expected_date TEXT NOT NULL,
      category TEXT,
      notes TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS weekly_checkins (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      checkin_date TEXT NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS category_budgets (
      id SERIAL PRIMARY KEY,
      category TEXT UNIQUE NOT NULL,
      monthly_amount REAL NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS deleted_expenses (
      id SERIAL PRIMARY KEY,
      description TEXT,
      amount REAL,
      expense_date TEXT,
      user_id INTEGER,
      deleted_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(description, amount, expense_date, user_id)
    );

    CREATE TABLE IF NOT EXISTS category_rules (
      id SERIAL PRIMARY KEY,
      supplier_pattern TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS retention_profiles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) UNIQUE,
      retention_method TEXT NOT NULL DEFAULT 'auto',
      fixed_amount REAL DEFAULT 0,
      lookback_weeks INTEGER NOT NULL DEFAULT 8,
      buffer_percent REAL NOT NULL DEFAULT 10,
      expense_source TEXT NOT NULL DEFAULT 'all',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS goal_contributions (
      id SERIAL PRIMARY KEY,
      goal_id INTEGER NOT NULL REFERENCES savings_goals(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount REAL NOT NULL,
      income_entry_id INTEGER REFERENCES income_entries(id),
      notes TEXT,
      contributed_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add offset-centric columns if missing
  try {
    await pool.query('ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS is_offset_bucket INTEGER NOT NULL DEFAULT 1');
    await pool.query('ALTER TABLE income_entries ADD COLUMN IF NOT EXISTS retention_amount REAL');
    await pool.query('ALTER TABLE income_entries ADD COLUMN IF NOT EXISTS offset_transfer REAL');
    await pool.query('ALTER TABLE income_entries ADD COLUMN IF NOT EXISTS mortgage_contribution REAL');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS mortgage_contribution REAL NOT NULL DEFAULT 0');
  } catch (e) { /* columns may already exist */ }

  // Set mortgage contributions if not yet set (Adam $2,857/mo, Aruto $1,800/mo)
  try {
    await pool.query("UPDATE users SET mortgage_contribution = 2857 WHERE username = 'adam' AND mortgage_contribution = 0");
    await pool.query("UPDATE users SET mortgage_contribution = 1800 WHERE username = 'aruto' AND mortgage_contribution = 0");
  } catch (e) { /* ignore */ }

  // Fix Aruto's gross income (was 70000, should be 95000 → ~$1,220/wk net)
  try {
    await pool.query("UPDATE users SET gross_income = 95000 WHERE username = 'aruto' AND gross_income = 70000");
  } catch (e) { /* ignore */ }

  // Update offset balance to latest known value if it was mangled by auto-mortgage
  try {
    const offsetRow = (await pool.query("SELECT balance FROM account_balances WHERE account_type = 'offset' ORDER BY updated_at DESC LIMIT 1")).rows[0];
    const currentBal = offsetRow ? offsetRow.balance : 0;
    // If balance dropped below $58k due to erroneous auto-debit, restore it
    if (currentBal < 58000 && currentBal > 0) {
      const admin = (await pool.query("SELECT id FROM users WHERE username = 'adam'")).rows[0];
      if (admin) {
        await pool.query("INSERT INTO account_balances (account_type, balance, updated_by) VALUES ('offset', 58236.51, $1)", [admin.id]);
        console.log(`Restored offset balance from $${currentBal} to $58,236.51`);
      }
    }
  } catch (e) { /* ignore */ }

  // Seed historical income entries (Aruto $450/wk to offset, Adam fortnightly)
  try {
    const existingIncome = (await pool.query('SELECT COUNT(*) as cnt FROM income_entries')).rows[0];
    if (parseInt(existingIncome.cnt) === 0) {
      const adamRow = (await pool.query("SELECT id FROM users WHERE username = 'adam'")).rows[0];
      const arutoRow = (await pool.query("SELECT id FROM users WHERE username = 'aruto'")).rows[0];
      if (adamRow && arutoRow) {
        // Aruto: ~$1,220/wk net, retains $770, mortgage $415.38/wk ($1800/mo), surplus $34.62/wk to offset
        const arutoWeeklyNet = 1220;
        const arutoRetention = 770;
        const arutoMortgage = Math.round(1800 * 12 / 52 * 100) / 100; // $415.38/wk
        const arutoOffset = arutoWeeklyNet - arutoRetention; // $450 total to offset
        // Adam: ~$3,914 fortnightly net, retains ~$1,400, mortgage $1,428.50/fn ($2857/mo), surplus ~$1,085.50/fn
        const adamFnNet = 3914;
        const adamRetention = 1400;
        const adamMortgage = Math.round(2857 * 12 / 26 * 100) / 100; // $1,318.62/fn
        const adamOffset = adamFnNet - adamRetention; // $2,514 total to offset

        const startDate = new Date('2026-01-06'); // First Monday after data start
        const today = new Date();

        // Aruto's weekly entries
        let d = new Date(startDate);
        while (d <= today) {
          const dateStr = d.toISOString().split('T')[0];
          await pool.query(
            'INSERT INTO income_entries (user_id, amount, net_amount, pay_date, pay_type, retention_amount, offset_transfer, mortgage_contribution) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [arutoRow.id, arutoWeeklyNet, arutoWeeklyNet, dateStr, 'regular', arutoRetention, arutoOffset, arutoMortgage]
          );
          d.setDate(d.getDate() + 7);
        }

        // Adam's fortnightly entries
        d = new Date(startDate);
        while (d <= today) {
          const dateStr = d.toISOString().split('T')[0];
          await pool.query(
            'INSERT INTO income_entries (user_id, amount, net_amount, pay_date, pay_type, retention_amount, offset_transfer, mortgage_contribution) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [adamRow.id, adamFnNet, adamFnNet, dateStr, 'regular', adamRetention, adamOffset, adamMortgage]
          );
          d.setDate(d.getDate() + 14);
        }
        console.log('Historical income entries seeded for Adam and Aruto');
      }
    }
  } catch (e) { console.error('Income seed error:', e.message); }

  // Log existing data counts for diagnostics
  const userCount = (await pool.query('SELECT COUNT(*) as count FROM users')).rows[0].count;
  const expenseCount = (await pool.query('SELECT COUNT(*) as count FROM expenses')).rows[0].count;
  console.log(`Database status: ${userCount} users, ${expenseCount} expenses`);

  // Seed default users if none exist
  if (parseInt(userCount) === 0) {
    console.log('New database — seeding default users...');
    const hash1 = bcrypt.hashSync('GoPies2023', 10);
    const hash2 = bcrypt.hashSync('GoPies2023', 10);

    await pool.query(
      'INSERT INTO users (username, display_name, password_hash, role, gross_income, super_rate, hecs_repayment_rate, pay_cycle, mortgage_contribution) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      ['adam', 'Adam', hash1, 'primary', 159000, 0.115, 0.06, 'fortnightly', 2857]
    );
    await pool.query(
      'INSERT INTO users (username, display_name, password_hash, role, gross_income, super_rate, hecs_repayment_rate, pay_cycle, mortgage_contribution) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      ['aruto', 'Aruto', hash2, 'partner', 95000, 0.115, 0.04, 'weekly', 1800]
    );

    const user1Res = await pool.query('SELECT id FROM users WHERE username = $1', ['adam']);
    const user1Id = user1Res.rows[0]?.id;
    if (user1Id) {
      await pool.query('INSERT INTO account_balances (account_type, balance, updated_by) VALUES ($1, $2, $3)', ['offset', 58236.51, user1Id]);
      await pool.query('INSERT INTO account_balances (account_type, balance, updated_by) VALUES ($1, $2, $3)', ['savings', 0, user1Id]);
      await pool.query('INSERT INTO account_balances (account_type, balance, updated_by) VALUES ($1, $2, $3)', ['credit_card', 0, user1Id]);
      await pool.query('INSERT INTO account_balances (account_type, balance, updated_by) VALUES ($1, $2, $3)', ['investment', 0, user1Id]);

      // Seed default levers
      const insertLever = 'INSERT INTO levers (name, description, lever_type, value, set_by) VALUES ($1, $2, $3, $4, $5)';
      await pool.query(insertLever, ['Offset Account %', 'Percentage of surplus allocated to offset account', 'percentage', 50, user1Id]);
      await pool.query(insertLever, ['Savings %', 'Percentage of surplus allocated to savings', 'percentage', 30, user1Id]);
      await pool.query(insertLever, ['Investment %', 'Percentage of surplus allocated to investments', 'percentage', 10, user1Id]);
      await pool.query(insertLever, ['Budget Scale %', 'Scale all category budgets (100 = conservative base, 120 = 20% more spending room, 80 = tighter)', 'percentage', 100, user1Id]);
      console.log('Default levers seeded');

      // Seed retention profiles
      const user2Res = await pool.query('SELECT id FROM users WHERE username = $1', ['aruto']);
      const user2Id = user2Res.rows[0]?.id;
      await pool.query(
        'INSERT INTO retention_profiles (user_id, retention_method, lookback_weeks, buffer_percent, expense_source) VALUES ($1, $2, $3, $4, $5)',
        [user1Id, 'auto', 8, 10, 'credit_card']
      );
      if (user2Id) {
        await pool.query(
          'INSERT INTO retention_profiles (user_id, retention_method, lookback_weeks, buffer_percent, expense_source) VALUES ($1, $2, $3, $4, $5)',
          [user2Id, 'auto', 8, 10, 'direct']
        );
      }
      console.log('Default retention profiles seeded');
    }
    console.log('Default users seeded: adam, aruto');
  }

  // Seed expenses if none exist
  if (parseInt(expenseCount) === 0) {
    await seedStatementData();
  }

  // Seed category budgets if missing
  const budgetCount = (await pool.query('SELECT COUNT(*) as count FROM category_budgets')).rows[0].count;
  if (parseInt(budgetCount) === 0) {
    await seedCategoryBudgets();
  }

  // Migrate Pets → Other (category removed)
  await pool.query("UPDATE expenses SET category = 'Other' WHERE category = 'Pets'");
  await pool.query("DELETE FROM category_budgets WHERE category = 'Pets'");

  // Deactivate old percentage levers (offset-centric model)
  await pool.query("UPDATE levers SET active = 0 WHERE name IN ('Offset Account %', 'Savings %', 'Investment %') AND active = 1");

  // Ensure retention profiles exist for all users
  const allUsers = (await pool.query('SELECT id, username FROM users')).rows;
  for (const u of allUsers) {
    const exists = (await pool.query('SELECT id FROM retention_profiles WHERE user_id = $1', [u.id])).rows[0];
    if (!exists) {
      const src = u.username === 'aruto' ? 'direct' : 'credit_card';
      await pool.query(
        'INSERT INTO retention_profiles (user_id, retention_method, lookback_weeks, buffer_percent, expense_source) VALUES ($1, $2, $3, $4, $5)',
        [u.id, 'auto', 8, 10, src]
      );
    }
  }
}

async function seedCategoryBudgets() {
  const conservativeBudgets = [
    ['Groceries', 800], ['Dining Out', 200], ['Transport', 200],
    ['Utilities', 250], ['Insurance', 200], ['Entertainment', 100],
    ['Health', 100], ['Clothing', 80], ['Personal Care', 60],
    ['Subscriptions', 50], ['Gifts', 50],
    ['Education', 50], ['Home', 100], ['Other', 150]
  ];
  for (const [cat, amt] of conservativeBudgets) {
    await pool.query('INSERT INTO category_budgets (category, monthly_amount) VALUES ($1, $2) ON CONFLICT (category) DO NOTHING', [cat, amt]);
  }
  console.log('Category budgets seeded (conservative / high-savings): $' + conservativeBudgets.reduce((s, b) => s + b[1], 0) + '/mo');
}

function autoCategorizeTxn(desc, learnedRules) {
  const d = desc.toLowerCase();
  // Check learned category rules first (user-taught mappings)
  if (learnedRules && learnedRules.length > 0) {
    for (const rule of learnedRules) {
      if (d.includes(rule.supplier_pattern.toLowerCase())) return rule.category;
    }
  }
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
  if (/gift|flower|present|hamper|salvation army|gofundme/.test(d)) return 'Gifts';
  if (/course|book|udemy|education|tutor|uni|school|tafe|dymocks/.test(d)) return 'Education';
  if (/bunnings|ikea|officeworks|furniture|homeware|hardware|garden|plumb|electr|temple.*webster|mocka|ruggable|bed bath|kogan|supercheap auto|chuck trailer/.test(d)) return 'Home';
  if (/international transaction fee/.test(d)) return 'Other';
  if (/bpay.*deft|bpay.*payment|mortgage/.test(d)) return 'Mortgage';
  return 'Other';
}

async function seedStatementData() {
  const primaryUser = (await pool.query("SELECT id FROM users WHERE role = $1 OR username = $2", ['primary', 'adam'])).rows[0];
  if (!primaryUser) return;
  const userId = primaryUser.id;

  // Actual credit card statement transactions (Dec 2025 - Mar 2026)
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

  for (const [dateStr, desc, amount] of transactions) {
    const date = parseDate(dateStr);
    const category = autoCategorizeTxn(desc);
    await pool.query(
      'INSERT INTO expenses (user_id, category, description, amount, expense_date, entry_type, recurring) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [userId, category, desc, amount, date, 'actual', 0]
    );
  }
  console.log(`Seeded ${transactions.length} bank statement transactions`);

  // Seed savings goals if none exist
  const goalCount = (await pool.query('SELECT COUNT(*) as count FROM savings_goals')).rows[0].count;
  if (parseInt(goalCount) === 0) {
    await pool.query(
      'INSERT INTO savings_goals (name, target_amount, current_amount, priority, target_date, created_by, is_joint, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      ['Emergency Fund', 20000, 5700, 1, '2026-12-31', userId, 1, 1]
    );
    await pool.query(
      'INSERT INTO savings_goals (name, target_amount, current_amount, priority, target_date, created_by, is_joint, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      ['Holiday Fund', 5000, 1200, 3, '2026-10-01', userId, 1, 1]
    );
    console.log('Seeded savings goals');
  }

  // Seed historical goal_contributions from income_entries so chart has real data
  try {
    const contribCount = (await pool.query('SELECT COUNT(*) as cnt FROM goal_contributions')).rows[0];
    if (parseInt(contribCount.cnt) === 0) {
      const activeGoals = (await pool.query('SELECT id, name, current_amount, priority, created_at FROM savings_goals WHERE active = 1 ORDER BY priority')).rows;
      const incomeRows = (await pool.query('SELECT id, user_id, pay_date, offset_transfer, mortgage_contribution FROM income_entries ORDER BY pay_date ASC')).rows;
      if (activeGoals.length > 0 && incomeRows.length > 0) {
        // Determine proportional split based on current amounts (or equal if all zero)
        const totalCurrent = activeGoals.reduce((s, g) => s + (g.current_amount || 0), 0);
        const goalShares = activeGoals.map(g => {
          if (totalCurrent > 0) return (g.current_amount || 0) / totalCurrent;
          return 1 / activeGoals.length;
        });

        // Total offset growth from all income entries
        const totalOffsetIn = incomeRows.reduce((s, r) => s + (r.offset_transfer || 0), 0);

        // Monthly mortgage total (all users combined)
        const users = (await pool.query('SELECT id, mortgage_contribution FROM users')).rows;
        const monthlyMortgage = users.reduce((s, u) => s + (u.mortgage_contribution || 0), 0);

        // Walk through pay dates, accumulate contributions per goal
        const goalRunning = {};
        activeGoals.forEach(g => { goalRunning[g.id] = 0; });
        let lastMortgageMonth = null;

        // Group income by pay_date to handle combined household income
        const byDate = {};
        for (const inc of incomeRows) {
          if (!byDate[inc.pay_date]) byDate[inc.pay_date] = [];
          byDate[inc.pay_date].push(inc);
        }
        const dates = Object.keys(byDate).sort();

        for (const dateStr of dates) {
          const entries = byDate[dateStr];
          const dayOffset = entries.reduce((s, e) => s + (e.offset_transfer || 0), 0);

          // Allocate this pay's offset transfer proportionally to goals
          if (dayOffset > 0) {
            for (let i = 0; i < activeGoals.length; i++) {
              const goal = activeGoals[i];
              const amount = Math.round(dayOffset * goalShares[i] * 100) / 100;
              if (amount > 0) {
                goalRunning[goal.id] += amount;
                await pool.query(
                  "INSERT INTO goal_contributions (goal_id, user_id, amount, income_entry_id, notes, contributed_at) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)",
                  [goal.id, entries[0].user_id, amount, entries[0].id, 'PayDay contribution', dateStr + 'T12:00:00Z']
                );
              }
            }
          }

          // Check if mortgage deduction should happen (23rd of each month)
          const d = new Date(dateStr);
          const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          if (d.getDate() >= 23 && lastMortgageMonth !== monthKey && monthlyMortgage > 0) {
            lastMortgageMonth = monthKey;
            const totalInBuckets = Object.values(goalRunning).reduce((s, v) => s + v, 0);
            if (totalInBuckets > 0) {
              const mortgageDate = `${monthKey}-23T12:00:00Z`;
              for (const goal of activeGoals) {
                const share = goalRunning[goal.id] / totalInBuckets;
                const deduction = Math.round(monthlyMortgage * share * 100) / 100;
                goalRunning[goal.id] = Math.max(0, goalRunning[goal.id] - deduction);
                if (deduction > 0) {
                  await pool.query(
                    "INSERT INTO goal_contributions (goal_id, user_id, amount, notes, contributed_at) VALUES ($1, $2, $3, $4, $5::timestamptz)",
                    [goal.id, entries[0].user_id, -deduction, 'Mortgage deduction', mortgageDate]
                  );
                }
              }
            }
          }
        }

        // Adjust final running totals to match current_amount (small correction contribution)
        for (const goal of activeGoals) {
          const diff = (goal.current_amount || 0) - goalRunning[goal.id];
          if (Math.abs(diff) > 0.01) {
            const lastDate = dates[dates.length - 1] || new Date().toISOString().split('T')[0];
            await pool.query(
              "INSERT INTO goal_contributions (goal_id, user_id, amount, notes, contributed_at) VALUES ($1, $2, $3, $4, $5::timestamptz)",
              [goal.id, userId, diff, 'Balance adjustment', lastDate + 'T18:00:00Z']
            );
          }
        }

        console.log('Seeded historical goal contributions from income entries');
      }
    }
  } catch (e) { console.error('Goal contributions seed error:', e.message); }
}

async function getCategoryRules() {
  try {
    const { rows } = await pool.query('SELECT supplier_pattern, category FROM category_rules ORDER BY id');
    return rows;
  } catch (err) {
    return [];
  }
}

module.exports = { getDb, autoCategorizeTxn, getCategoryRules };
