const API = '';

export function getHeaders() {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

export async function apiFetch(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { ...getHeaders(), ...options.headers }
  });
  if (res.status === 401) {
    localStorage.removeItem('token');
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  const contentType = res.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return res.json();
  }
  return res;
}

// Dashboard
export const getDashboard = () => apiFetch('/api/dashboard');

// Expenses
export const getExpenses = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(`/api/expenses${qs ? '?' + qs : ''}`);
};
export const addExpense = (data) => apiFetch('/api/expenses', { method: 'POST', body: JSON.stringify(data) });
export const addExpensesBatch = (expenses) => apiFetch('/api/expenses/batch', { method: 'POST', body: JSON.stringify({ expenses }) });
export const deleteExpense = (id) => apiFetch(`/api/expenses/${id}`, { method: 'DELETE' });

// Income
export const getIncome = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(`/api/income${qs ? '?' + qs : ''}`);
};
export const addIncome = (data) => apiFetch('/api/income', { method: 'POST', body: JSON.stringify(data) });

// Allocations
export const getAllocations = () => apiFetch('/api/allocations');
export const addAllocations = (data) => apiFetch('/api/allocations', { method: 'POST', body: JSON.stringify(data) });

// Balances
export const getBalances = () => apiFetch('/api/balances');
export const updateBalance = (account, balance) => apiFetch(`/api/balances/${account}`, { method: 'PUT', body: JSON.stringify({ balance }) });

// Goals
export const getGoals = () => apiFetch('/api/goals');
export const addGoal = (data) => apiFetch('/api/goals', { method: 'POST', body: JSON.stringify(data) });
export const updateGoal = (id, data) => apiFetch(`/api/goals/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteGoal = (id) => apiFetch(`/api/goals/${id}`, { method: 'DELETE' });

// Levers
export const getLevers = () => apiFetch('/api/levers');
export const addLever = (data) => apiFetch('/api/levers', { method: 'POST', body: JSON.stringify(data) });
export const updateLever = (id, data) => apiFetch(`/api/levers/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteLever = (id) => apiFetch(`/api/levers/${id}`, { method: 'DELETE' });

// Upcoming Expenses
export const getUpcomingExpenses = () => apiFetch('/api/upcoming-expenses');
export const addUpcomingExpense = (data) => apiFetch('/api/upcoming-expenses', { method: 'POST', body: JSON.stringify(data) });
export const resolveUpcomingExpense = (id) => apiFetch(`/api/upcoming-expenses/${id}`, { method: 'PUT', body: JSON.stringify({ resolved: true }) });

// Claude AI
export const getPayDayAdvice = (data) => apiFetch('/api/claude/payday-advice', { method: 'POST', body: JSON.stringify(data) });
export const getNightlySummary = () => apiFetch('/api/claude/nightly-summary', { method: 'POST' });
export const getLatestAdvice = (type) => apiFetch(`/api/claude/latest-advice?type=${type}`);

// Projections
export const getProjections = () => apiFetch('/api/projections');

// Export
export const exportToExcel = async (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  const token = localStorage.getItem('token');
  const res = await fetch(`${API}/api/export${qs ? '?' + qs : ''}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('Export failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `budget_export.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
};
