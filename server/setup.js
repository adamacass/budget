require('dotenv').config();
const { getDb } = require('./db');

async function setup() {
  // getDb() handles schema creation, user seeding, and transaction seeding automatically
  await getDb();
  console.log('Setup complete! Database initialized with default data.');
  console.log('  adam / GoPies2023 (Primary - $159k, fortnightly)');
  console.log('  aruto / GoPies2023 (Partner - $70k, weekly)');
  console.log('  Offset account set to $57,000');
  console.log('  Default savings goals and levers created');
  process.exit(0);
}

setup().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});
