import React, { useState, useEffect } from 'react';
import { getExpenses, addExpense, addExpensesBatch, deleteExpense } from '../api';
import { Plus, Trash2, Filter } from 'lucide-react';

const CATEGORIES = [
  'Groceries', 'Dining Out', 'Transport', 'Utilities', 'Insurance',
  'Entertainment', 'Health', 'Clothing', 'Personal Care', 'Subscriptions',
  'Pets', 'Gifts', 'Education', 'Home', 'Mortgage', 'Other'
];

const SYDNEY_RANGES = {
  Groceries: [200, 300], 'Dining Out': [50, 125], Transport: [50, 100],
  Utilities: [75, 115], Insurance: [50, 90], Entertainment: [35, 75],
  Health: [35, 75], Clothing: [25, 65], 'Personal Care': [20, 40],
  Subscriptions: [15, 40], Pets: [15, 50], Gifts: [15, 50]
};

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export default function Expenses() {
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [entryMode, setEntryMode] = useState('individual');
  const [filter, setFilter] = useState('');
  const [dateRange, setDateRange] = useState({ start: '', end: '' });

  // Individual entry form
  const [form, setForm] = useState({
    category: 'Groceries', subcategory: '', description: '', amount: '',
    expense_date: new Date().toISOString().split('T')[0], recurring: false
  });

  // Range entry (weekly check-in)
  const [rangeEntries, setRangeEntries] = useState(
    CATEGORIES.slice(0, 12).map(cat => ({
      category: cat,
      amount: '',
      range_low: SYDNEY_RANGES[cat]?.[0] || '',
      range_high: SYDNEY_RANGES[cat]?.[1] || '',
      is_range: true,
      use_range: false
    }))
  );

  useEffect(() => { loadExpenses(); }, []);

  async function loadExpenses() {
    setLoading(true);
    try {
      const params = {};
      if (dateRange.start) params.start = dateRange.start;
      if (dateRange.end) params.end = dateRange.end;
      if (filter) params.category = filter;
      const data = await getExpenses(params);
      setExpenses(data);
    } catch (err) { console.error(err); }
    setLoading(false);
  }

  async function handleAddSingle(e) {
    e.preventDefault();
    try {
      const expense = await addExpense({
        ...form,
        amount: parseFloat(form.amount),
        entry_type: 'actual',
        is_range: false
      });
      setExpenses(prev => [expense, ...prev]);
      setForm({ ...form, subcategory: '', description: '', amount: '' });
      setShowAdd(false);
    } catch (err) { alert(err.message); }
  }

  async function handleAddRanges() {
    const entries = rangeEntries
      .filter(e => e.amount || e.use_range)
      .map(e => ({
        category: e.category,
        amount: e.use_range ? ((parseFloat(e.range_low) + parseFloat(e.range_high)) / 2) : parseFloat(e.amount),
        expense_date: new Date().toISOString().split('T')[0],
        entry_type: e.use_range ? 'estimated' : 'actual',
        is_range: e.use_range,
        range_low: e.use_range ? parseFloat(e.range_low) : null,
        range_high: e.use_range ? parseFloat(e.range_high) : null,
        description: e.use_range ? `Weekly estimate (${e.range_low}-${e.range_high})` : 'Weekly check-in entry'
      }));
    if (entries.length === 0) return alert('Enter at least one amount or use ranges');
    try {
      await addExpensesBatch(entries);
      loadExpenses();
      setShowAdd(false);
    } catch (err) { alert(err.message); }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this expense?')) return;
    await deleteExpense(id);
    setExpenses(prev => prev.filter(e => e.id !== id));
  }

  const total = expenses.reduce((s, e) => s + e.amount, 0);

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>Expenses</h2>
          <p>Track every dollar or estimate weekly ranges</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAdd(!showAdd)}>
          <Plus size={16} /> Add Expense
        </button>
      </div>

      {showAdd && (
        <div className="card">
          <div className="tabs">
            <button className={`tab ${entryMode === 'individual' ? 'active' : ''}`} onClick={() => setEntryMode('individual')}>
              Individual Entry
            </button>
            <button className={`tab ${entryMode === 'range' ? 'active' : ''}`} onClick={() => setEntryMode('range')}>
              Weekly Check-in (Ranges)
            </button>
          </div>

          {entryMode === 'individual' ? (
            <form onSubmit={handleAddSingle}>
              <div className="form-row">
                <div className="form-group">
                  <label>Category</label>
                  <select className="form-select" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                    {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Amount ($)</label>
                  <input className="form-input" type="number" step="0.01" value={form.amount}
                    onChange={e => setForm({ ...form, amount: e.target.value })} required placeholder="0.00" />
                </div>
                <div className="form-group">
                  <label>Date</label>
                  <input className="form-input" type="date" value={form.expense_date}
                    onChange={e => setForm({ ...form, expense_date: e.target.value })} required />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Subcategory (optional)</label>
                  <input className="form-input" value={form.subcategory}
                    onChange={e => setForm({ ...form, subcategory: e.target.value })} placeholder="e.g. Woolworths, Uber" />
                </div>
                <div className="form-group">
                  <label>Description</label>
                  <input className="form-input" value={form.description}
                    onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. Weekly shop, coffee" />
                </div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', marginBottom: '1rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.recurring} onChange={e => setForm({ ...form, recurring: e.target.checked })} />
                Recurring expense
              </label>
              <button className="btn btn-primary" type="submit">Add Expense</button>
            </form>
          ) : (
            <div>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                Quick weekly check-in. Enter actual amounts or toggle to use Sydney mid-high range estimates.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Use Range?</th>
                      <th>Weekly Range (Sydney)</th>
                      <th>Actual Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rangeEntries.map((entry, i) => (
                      <tr key={entry.category}>
                        <td style={{ fontWeight: 600 }}>{entry.category}</td>
                        <td>
                          <input type="checkbox" checked={entry.use_range}
                            onChange={e => {
                              const copy = [...rangeEntries];
                              copy[i] = { ...copy[i], use_range: e.target.checked };
                              setRangeEntries(copy);
                            }} />
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <input className="form-input" type="number" value={entry.range_low} style={{ width: 80 }}
                              onChange={e => {
                                const copy = [...rangeEntries];
                                copy[i] = { ...copy[i], range_low: e.target.value };
                                setRangeEntries(copy);
                              }} />
                            <span style={{ color: 'var(--text-muted)' }}>-</span>
                            <input className="form-input" type="number" value={entry.range_high} style={{ width: 80 }}
                              onChange={e => {
                                const copy = [...rangeEntries];
                                copy[i] = { ...copy[i], range_high: e.target.value };
                                setRangeEntries(copy);
                              }} />
                          </div>
                        </td>
                        <td>
                          <input className="form-input" type="number" step="0.01" value={entry.amount}
                            disabled={entry.use_range}
                            style={{ width: 120 }}
                            placeholder={entry.use_range ? 'Using range' : '0.00'}
                            onChange={e => {
                              const copy = [...rangeEntries];
                              copy[i] = { ...copy[i], amount: e.target.value };
                              setRangeEntries(copy);
                            }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button className="btn btn-primary" style={{ marginTop: '1rem' }} onClick={handleAddRanges}>
                Submit Weekly Check-in
              </button>
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="card" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end' }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>From</label>
          <input className="form-input" type="date" value={dateRange.start} onChange={e => setDateRange({ ...dateRange, start: e.target.value })} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>To</label>
          <input className="form-input" type="date" value={dateRange.end} onChange={e => setDateRange({ ...dateRange, end: e.target.value })} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Category</label>
          <select className="form-select" value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="">All</option>
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={loadExpenses}><Filter size={14} /> Apply</button>
        <button className="btn btn-ghost btn-sm" onClick={() => { setDateRange({ start: '', end: '' }); setFilter(''); setTimeout(loadExpenses, 0); }}>Clear</button>
      </div>

      {/* Summary */}
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600 }}>Total: {fmtMoney(total)}</span>
        <span style={{ color: 'var(--text-muted)' }}>{expenses.length} entries</span>
      </div>

      {/* Expenses Table */}
      <div className="card">
        {loading ? <div style={{ textAlign: 'center', padding: '2rem' }}><div className="spinner" /></div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>User</th>
                  <th>Category</th>
                  <th>Description</th>
                  <th>Amount</th>
                  <th>Type</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {expenses.length === 0 ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem' }}>
                    No expenses yet. Click "Add Expense" to start tracking.
                  </td></tr>
                ) : expenses.map(e => (
                  <tr key={e.id}>
                    <td>{e.expense_date}</td>
                    <td>{e.user_name}</td>
                    <td>
                      <span className="tag tag-blue">{e.category}</span>
                      {e.subcategory && <span style={{ marginLeft: 4, fontSize: '0.75rem', color: 'var(--text-muted)' }}>{e.subcategory}</span>}
                    </td>
                    <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{e.description || '-'}</td>
                    <td style={{ fontWeight: 600 }}>
                      {e.is_range ? (
                        <span>{fmtMoney(e.range_low)} - {fmtMoney(e.range_high)}</span>
                      ) : fmtMoney(e.amount)}
                    </td>
                    <td>
                      <span className={`tag ${e.entry_type === 'estimated' ? 'tag-yellow' : 'tag-green'}`}>
                        {e.entry_type === 'estimated' ? 'Est.' : 'Actual'}
                      </span>
                      {e.recurring ? <span className="tag tag-blue" style={{ marginLeft: 4 }}>Recurring</span> : null}
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(e.id)} title="Delete">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
