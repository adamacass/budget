// Categorises a batch of transaction descriptions, for screenshot imports.
//
// Order of precedence:
//   1. a rule you've taught the app (category_rules) always wins
//   2. otherwise Claude picks, using your own past expenses as examples,
//      except where Claude is unsure and a built-in pattern is confident
//   3. if Claude is unavailable or fails, the built-in merchant patterns in db.js
//
// Returns one { category, confidence, matched } per description, in order, in
// the same shape as categorizeTxnDetailed so callers can use either.

const { categorizeTxnDetailed, getCategoryRules } = require('./db');
const claude = require('./claude');

const ALWAYS_AVAILABLE = ['Transfer', 'Mortgage', 'Other'];
const EXAMPLE_LIMIT = 150;

async function categoryList(pool) {
  const rows = (await pool.query(
    `SELECT category FROM category_budgets
     UNION SELECT DISTINCT category FROM expenses WHERE entry_type = 'actual'`
  )).rows.map(r => r.category);
  return [...new Set([...rows, ...ALWAYS_AVAILABLE])].sort();
}

// The merchants you use most, with the category you've given them
async function pastExamples(pool) {
  return (await pool.query(
    `SELECT description, category FROM (
       SELECT description, category, COUNT(*) AS n,
              ROW_NUMBER() OVER (PARTITION BY lower(description) ORDER BY COUNT(*) DESC) AS pick
       FROM expenses
       WHERE entry_type = 'actual' AND description IS NOT NULL AND description <> ''
       GROUP BY description, category
     ) x WHERE pick = 1 ORDER BY n DESC LIMIT $1`, [EXAMPLE_LIMIT]
  )).rows;
}

async function categorizeBatch(pool, descriptions) {
  const rules = await getCategoryRules();
  const results = descriptions.map(d => {
    const r = categorizeTxnDetailed(d || '', rules);
    return { ...r, fromRule: String(r.matched || '').startsWith('rule:') };
  });

  const todo = results.map((r, i) => (r.fromRule ? null : i)).filter(i => i !== null);
  if (!todo.length) return results.map(strip);

  try {
    const categories = await categoryList(pool);
    const picked = await claude.categorizeTransactions(
      todo.map(i => descriptions[i] || ''),
      { categories, examples: await pastExamples(pool) }
    );
    if (picked) {
      todo.forEach((i, k) => {
        const p = picked[k];
        if (!p || !categories.includes(p.category)) return;
        // A confident built-in pattern beats a Claude guess (e.g. "BPAY DEFT" is the mortgage)
        if (p.confidence !== 'high' && results[i].confidence === 'high') return;
        results[i] = { category: p.category, confidence: p.confidence === 'high' ? 'high' : 'low', matched: 'claude' };
      });
    }
  } catch (e) {
    console.error(`[categorize] falling back to built-in patterns: ${e.message}`);
  }
  return results.map(strip);
}

function strip({ category, confidence, matched }) {
  return { category, confidence, matched };
}

module.exports = { categorizeBatch };
