// Distinct colours for each category and user — used in charts and UI badges
export const CATEGORY_COLORS = {
  'Groceries': '#55efc4',
  'Dining Out': '#ff9f43',
  'Transport': '#54a0ff',
  'Utilities': '#feca57',
  'Insurance': '#a29bfe',
  'Entertainment': '#fd79a8',
  'Health': '#00cec9',
  'Clothing': '#e17055',
  'Personal Care': '#fab1a0',
  'Subscriptions': '#74b9ff',
  'Gifts': '#e84393',
  'Education': '#0984e3',
  'Home': '#6c5ce7',
  'Mortgage': '#d63031',
  'Other': '#636e72',
};

export const USER_COLORS = {
  adam: '#6c5ce7',
  aruto: '#00cec9',
};

export const CATEGORIES = [
  'Groceries', 'Dining Out', 'Transport', 'Utilities', 'Insurance',
  'Entertainment', 'Health', 'Clothing', 'Personal Care', 'Subscriptions',
  'Gifts', 'Education', 'Home', 'Mortgage', 'Other'
];

export function getCategoryColor(category) {
  return CATEGORY_COLORS[category] || '#636e72';
}

export function getUserColor(name) {
  if (!name) return '#636e72';
  const lower = name.toLowerCase();
  if (lower.includes('adam')) return USER_COLORS.adam;
  if (lower.includes('aruto')) return USER_COLORS.aruto;
  return '#636e72';
}

export function getUserClass(name) {
  if (!name) return '';
  const lower = name.toLowerCase();
  if (lower.includes('adam')) return 'adam';
  if (lower.includes('aruto')) return 'aruto';
  return '';
}
