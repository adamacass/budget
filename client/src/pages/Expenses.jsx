import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { getExpenses, getExpenseSummary, addExpense, addExpensesBatch, deleteExpense, updateExpense } from '../api';
import { Plus, Trash2, Filter, Zap, Users, X, Check, ChevronDown, ChevronUp, ArrowLeft, Edit3, Save, Tag } from 'lucide-react';
import { CATEGORIES, getCategoryColor, getUserColor, getUserClass } from '../categoryColors';

const SYDNEY_RANGES = {
  Groceries: [200, 300], 'Dining Out': [50, 125], Transport: [50, 100],
  Utilities: [75, 115], Insurance: [50, 90], Entertainment: [35, 75],
  Health: [35, 75], Clothing: [25, 65], 'Personal Care': [20, 40],
  Subscriptions: [15, 40], Gifts: [15, 50]
};

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtShort(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }

export default function Expenses() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [expenses, setExpenses] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [entryMode, setEntryMode] = useState('individual');
  const [period, setPeriod] = useState('week');
  const [showFilters, setShowFilters] = useState(false);

  // Active filters from URL params
  const activeCategory = searchParams.get('category') || '';
  const activeUserId = searchParams.get('user_id') || '';
  const activeStart = searchParams.get('start') || '';
  const activeEnd = searchParams.get('end') || '';
  const hasActiveFilters = activeCategory || activeUserId || activeStart || activeEnd;

  // Speed run state
  const [speedRunMode, setSpeedRunMode] = useState(false);
  const [uncategorized, setUncategorized] = useState([]);
  const [speedRunIndex, setSpeedRunIndex] = useState(0);
  const [speedRunSaving, setSpeedRunSaving] = useState(false);

  // Inline editing state
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});

  // Categorisation mode
  const [catMode, setCatMode] = useState(false);
  const [catModeItems, setCatModeItems] = useState([]);
  const [catModeIndex, setCatModeIndex] = useState(0);
  const [catModeSaving, setCatModeSaving] = useState(false);

  // Individual entry form
  const [form, setForm] = useState({
    category: 'Groceries', subcategory: '', description: '', amount: '',
    expense_date: new Date().toISOString().split('T')[0], recurring: false
  });

  // Range entry
  const [rangeEntries, setRangeEntries] = useState(
    CATEGORIES.slice(0, 12).map(cat => ({
      category: cat, amount: '', range_low: SYDNEY_RANGES[cat]?.[0] || '',
      range_high: SYDNEY_RANGES[cat]?.[1] || '', is_range: true, use_range: false
    }))
  );

  useEffect(() => { loadExpenses(); }, [activeCategory, activeUserId, activeStart, activeEnd]);
  useEffect(() => { loadSummary(); }, []);

  async function loadExpenses() {
    setLoading(true);
    try {
      const params = {};
      if (activeStart) params.start = activeStart;
      if (activeEnd) params.end = activeEnd;
      if (activeCategory) params.category = activeCategory;
      if (activeUserId) params.user_id = activeUserId;
      const data = await getExpenses(params);
      setExpenses(data);
    } catch (err) { console.error(err); }
    setLoading(false);
  }

  async function loadSummary() {
    try { setSummary(await getExpenseSummary()); } catch (err) { console.error(err); }
  }

  function setFilter(key, value) {
    const newParams = new URLSearchParams(searchParams);
    if (value) newParams.set(key, value);
    else newParams.delete(key);
    setSearchParams(newParams);
  }

  function clearAllFilters() { setSearchParams({}); }

  function filterByCategory(category) {
    setFilter('category', activeCategory === category ? '' : category);
  }

  function filterByUser(userId) {
    setFilter('user_id', activeUserId === String(userId) ? '' : String(userId));
  }

  async function handleAddSingle(e) {
    e.preventDefault();
    try {
      const expense = await addExpense({
        ...form, amount: parseFloat(form.amount),
        entry_type: 'actual', is_range: false
      });
      setExpenses(prev => [expense, ...prev]);
      setForm({ ...form, subcategory: '', description: '', amount: '' });
      setShowAdd(false);
      loadSummary();
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
      loadExpenses(); loadSummary(); setShowAdd(false);
    } catch (err) { alert(err.message); }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this expense?')) return;
    await deleteExpense(id);
    setExpenses(prev => prev.filter(e => e.id !== id));
    loadSummary();
  }

  // ===== INLINE EDITING =====
  function startEdit(expense) {
    setEditingId(expense.id);
    setEditForm({
      category: expense.category,
      description: expense.description || '',
      amount: expense.amount,
      expense_date: expense.expense_date,
      subcategory: expense.subcategory || '',
      recurring: !!expense.recurring,
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm({});
  }

  async function saveEdit() {
    try {
      const updated = await updateExpense(editingId, {
        ...editForm,
        amount: parseFloat(editForm.amount),
      });
      setExpenses(prev => prev.map(e => e.id === editingId ? { ...e, ...updated } : e));
      setEditingId(null);
      setEditForm({});
      loadSummary();
    } catch (err) { alert(err.message); }
  }

  // ===== SPEED RUN =====
  async function startSpeedRun() {
    try {
      const data = await getExpenses({ category: 'Other' });
      if (data.length === 0) { alert('No uncategorized expenses found!'); return; }
      setUncategorized(data);
      setSpeedRunIndex(0);
      setSpeedRunMode(true);
    } catch (err) { alert(err.message); }
  }

  async function categorizeExpense(id, category) {
    setSpeedRunSaving(true);
    try {
      await updateExpense(id, { category });
      setUncategorized(prev => prev.filter(e => e.id !== id));
    } catch (err) { alert(err.message); }
    setSpeedRunSaving(false);
  }

  function skipExpense() {
    setSpeedRunIndex(i => Math.min(i + 1, uncategorized.length));
  }

  // ===== CATEGORISATION MODE =====
  async function startCatMode() {
    try {
      const data = await getExpenses({ category: 'Other' });
      if (data.length === 0) { alert('No "Other" transactions to categorise!'); return; }
      setCatModeItems(data);
      setCatModeIndex(0);
      setCatMode(true);
    } catch (err) { alert(err.message); }
  }

  async function catModeAssign(category) {
    const item = catModeItems[catModeIndex];
    if (!item) return;
    setCatModeSaving(true);
    try {
      await updateExpense(item.id, { category });
      setCatModeItems(prev => prev.filter(e => e.id !== item.id));
      // index stays same because the array shrinks
    } catch (err) { alert(err.message); }
    setCatModeSaving(false);
  }

  async function catModeMarkIncome() {
    const item = catModeItems[catModeIndex];
    if (!item) return;
    setCatModeSaving(true);
    try {
      // Delete the expense and add as income
      await deleteExpense(item.id);
      setCatModeItems(prev => prev.filter(e => e.id !== item.id));
    } catch (err) { alert(err.message); }
    setCatModeSaving(false);
  }

  function catModeSkip() {
    setCatModeIndex(i => Math.min(i + 1, catModeItems.length - 1));
  }

  const currentPeriod = summary?.[period];
  const maxUserTotal = currentPeriod ? Math.max(...(currentPeriod.by_user?.map(u => u.total) || [1]), 1) : 1;
  const total = expenses.reduce((s, e) => s + e.amount, 0);

  // Speed run current expense
  const speedRunCurrent = uncategorized[speedRunIndex];
  const catModeCurrent = catModeItems[catModeIndex];

  return (
    <div>
      {/* Speed Run Modal */}
      {speedRunMode && (
        <div className="modal-overlay" onClick={() => setSpeedRunMode(false)}>
          <div className="modal speed-run-modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Zap size={18} style={{ color: 'var(--yellow)' }} /> Speed Run
              </h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setSpeedRunMode(false)}><X size={14} /></button>
            </div>

            {uncategorized.length > 0 && speedRunIndex < uncategorized.length ? (
              <>
                <div className="speed-run-progress">
                  <div className="progress-bar" style={{ height: 4, margin: 0 }}>
                    <div className="progress-fill green" style={{ width: `${((uncategorized.length - (uncategorized.length - speedRunIndex)) / (uncategorized.length + speedRunIndex)) * 100}%` }} />
                  </div>
                  <span>{uncategorized.length} remaining</span>
                </div>

                <div className="speed-run-expense">
                  <div className="speed-run-date">{speedRunCurrent.expense_date}</div>
                  <div className="speed-run-desc">{speedRunCurrent.description || 'No description'}</div>
                  <div className="speed-run-amount">{fmtMoney(speedRunCurrent.amount)}</div>
                  <div className="speed-run-user">{speedRunCurrent.user_name}</div>
                </div>

                <div className="speed-run-categories">
                  {CATEGORIES.filter(c => c !== 'Other').map(c => (
                    <button
                      key={c}
                      className="speed-run-cat-btn"
                      disabled={speedRunSaving}
                      onClick={() => categorizeExpense(speedRunCurrent.id, c)}
                      style={{ borderLeftColor: getCategoryColor(c), borderLeftWidth: 3 }}
                    >
                      {c}
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', justifyContent: 'center' }}>
                  <button className="btn btn-ghost btn-sm" onClick={skipExpense}>Skip</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setSpeedRunMode(false)}>Done</button>
                </div>
              </>
            ) : (
              <div style={{ textAlign: 'center', padding: '2rem' }}>
                <Check size={36} style={{ color: 'var(--green)', marginBottom: '0.5rem' }} />
                <div style={{ fontWeight: 600 }}>All done!</div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.25rem' }}>No more uncategorized expenses.</div>
                <button className="btn btn-primary" style={{ marginTop: '1rem' }} onClick={() => { setSpeedRunMode(false); loadExpenses(); loadSummary(); }}>Close</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== CATEGORISATION MODE ===== */}
      {catMode && (
        <div className="cat-mode-card">
          <div className="cat-mode-header">
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1rem' }}>
              <Tag size={16} style={{ color: 'var(--yellow)' }} /> Categorisation Mode
            </h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <span className="cat-mode-counter">{catModeItems.length} remaining</span>
              <button className="btn btn-ghost btn-sm" onClick={() => { setCatMode(false); loadExpenses(); loadSummary(); }}>
                <X size={14} /> Exit
              </button>
            </div>
          </div>

          {catModeItems.length > 0 && catModeIndex < catModeItems.length ? (
            <>
              <div className="progress-bar" style={{ height: 4, marginBottom: '1rem' }}>
                <div className="progress-fill green" style={{ width: `${catModeItems.length > 0 ? ((catModeItems.length - catModeItems.length) / 1 || 5) : 0}%` }} />
              </div>

              <div className="cat-mode-expense">
                <div className="speed-run-date">{catModeCurrent.expense_date}</div>
                <div className="speed-run-desc">{catModeCurrent.description || 'No description'}</div>
                <div className="speed-run-amount">{fmtMoney(catModeCurrent.amount)}</div>
                <div className="speed-run-user" style={{ color: getUserColor(catModeCurrent.user_name) }}>
                  {catModeCurrent.user_name}
                </div>
              </div>

              <div className="cat-mode-grid">
                {CATEGORIES.filter(c => c !== 'Other').map(c => (
                  <button
                    key={c}
                    className="cat-mode-btn"
                    disabled={catModeSaving}
                    onClick={() => catModeAssign(c)}
                    style={{ borderLeft: `3px solid ${getCategoryColor(c)}` }}
                  >
                    {c}
                  </button>
                ))}
                <button
                  className="cat-mode-btn income-btn"
                  disabled={catModeSaving}
                  onClick={catModeMarkIncome}
                  title="This is income, not an expense — remove it"
                >
                  Income (remove)
                </button>
              </div>

              <div className="cat-mode-nav">
                <button className="btn btn-ghost btn-sm" disabled={catModeIndex === 0} onClick={() => setCatModeIndex(i => i - 1)}>Prev</button>
                <button className="btn btn-ghost btn-sm" onClick={catModeSkip}>Skip</button>
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <Check size={36} style={{ color: 'var(--green)', marginBottom: '0.5rem' }} />
              <div style={{ fontWeight: 600 }}>All categorised!</div>
              <button className="btn btn-primary" style={{ marginTop: '1rem' }} onClick={() => { setCatMode(false); loadExpenses(); loadSummary(); }}>Done</button>
            </div>
          )}
        </div>
      )}

      {/* Active filter banner */}
      {hasActiveFilters && (
        <div className="active-filter-banner">
          <ArrowLeft size={14} />
          <span>Filtered:</span>
          {activeCategory && (
            <span className="filter-chip" onClick={() => setFilter('category', '')}>
              {activeCategory} <X size={12} />
            </span>
          )}
          {activeUserId && (
            <span className="filter-chip" onClick={() => setFilter('user_id', '')}>
              {expenses[0]?.user_name || `User ${activeUserId}`} <X size={12} />
            </span>
          )}
          {activeStart && (
            <span className="filter-chip" onClick={() => setFilter('start', '')}>
              From {activeStart} <X size={12} />
            </span>
          )}
          {activeEnd && (
            <span className="filter-chip" onClick={() => setFilter('end', '')}>
              To {activeEnd} <X size={12} />
            </span>
          )}
          <button className="btn btn-ghost btn-sm" onClick={clearAllFilters}>Clear all</button>
        </div>
      )}

      {/* Period Toggle + Speed Run + Cat Mode */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div className="period-toggle">
          <button className={period === 'week' ? 'active' : ''} onClick={() => setPeriod('week')}>Week</button>
          <button className={period === 'month' ? 'active' : ''} onClick={() => setPeriod('month')}>Month</button>
          <button className={period === 'year' ? 'active' : ''} onClick={() => setPeriod('year')}>Year</button>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-ghost btn-sm" onClick={startCatMode}>
            <Tag size={14} /> Categorise
          </button>
          <button className="btn btn-ghost btn-sm" onClick={startSpeedRun}>
            <Zap size={14} /> Speed Run
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      {currentPeriod && (
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="stat-card">
            <div className="stat-label">Total Spent</div>
            <div className="stat-value negative">{fmtShort(currentPeriod.total)}</div>
            <div className="card-sub">{currentPeriod.count} transactions</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Daily Average</div>
            <div className="stat-value warning">{fmtShort(currentPeriod.daily_avg)}</div>
            <div className="card-sub">per day</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Top Category</div>
            <div className="stat-value neutral clickable" style={{ fontSize: '1.1rem' }}
              onClick={() => currentPeriod.by_category?.[0] && filterByCategory(currentPeriod.by_category[0].category)}>
              {currentPeriod.by_category?.[0]?.category || '-'}
            </div>
            <div className="card-sub">{fmtShort(currentPeriod.by_category?.[0]?.total)}</div>
          </div>
        </div>
      )}

      {/* Adam vs Aruto */}
      {currentPeriod?.by_user?.length > 0 && (
        <div className="card">
          <div className="card-title">
            <Users size={14} /> Adam vs Aruto — {period === 'week' ? 'This Week' : period === 'month' ? 'This Month' : 'This Year'}
          </div>
          {currentPeriod.by_user.map((u) => (
            <div key={u.user_id} className="vs-row clickable" onClick={() => filterByUser(u.user_id)}>
              <div className="vs-avatar" style={{ background: getUserColor(u.display_name) }}>
                {u.display_name[0]}
              </div>
              <div className="vs-name">{u.display_name}</div>
              <div className="vs-bar-container">
                <div
                  className="vs-bar"
                  style={{
                    width: `${maxUserTotal > 0 ? (u.total / maxUserTotal) * 100 : 0}%`,
                    background: getUserColor(u.display_name)
                  }}
                />
              </div>
              <div className="vs-amount">{fmtShort(u.total)}</div>
              <div className="vs-count">{u.count} txns</div>
            </div>
          ))}
          {currentPeriod.by_user.length === 2 && (
            <div className="vs-diff">
              {(() => {
                const diff = Math.abs(currentPeriod.by_user[0].total - currentPeriod.by_user[1].total);
                if (diff < 1) return 'Equal spending!';
                const higher = currentPeriod.by_user[0].total > currentPeriod.by_user[1].total
                  ? currentPeriod.by_user[0] : currentPeriod.by_user[1];
                return `${higher.display_name} spent ${fmtShort(diff)} more`;
              })()}
            </div>
          )}
        </div>
      )}

      {/* Category Breakdown */}
      {currentPeriod?.by_category?.length > 0 && (
        <div className="card">
          <div className="card-title">Category Breakdown</div>
          <div className="budget-bars">
            {currentPeriod.by_category.slice(0, 8).map(c => {
              const pct = currentPeriod.total > 0 ? (c.total / currentPeriod.total) * 100 : 0;
              const isActive = activeCategory === c.category;
              return (
                <div key={c.category} className={`budget-bar-row clickable ${isActive ? 'selected' : ''}`}
                  onClick={() => filterByCategory(c.category)}>
                  <div className="budget-bar-label">
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: getCategoryColor(c.category), display: 'inline-block' }} />
                      {c.category}
                    </span>
                    <span>
                      <strong>{fmtShort(c.total)}</strong>
                      <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>({pct.toFixed(0)}%)</span>
                    </span>
                  </div>
                  <div className="progress-bar" style={{ height: 8, margin: '2px 0' }}>
                    <div className="progress-fill" style={{ width: `${pct}%`, background: getCategoryColor(c.category) }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Add Expense + Filters Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1.5rem', marginBottom: '0.75rem' }}>
        <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>All Expenses</h3>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowFilters(!showFilters)}>
            <Filter size={14} /> {showFilters ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(!showAdd)}>
            <Plus size={14} /> Add
          </button>
        </div>
      </div>

      {/* Add Expense Form */}
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
                            disabled={entry.use_range} style={{ width: 120 }}
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
      {showFilters && (
        <div className="card" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>From</label>
            <input className="form-input" type="date" value={activeStart}
              onChange={e => setFilter('start', e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>To</label>
            <input className="form-input" type="date" value={activeEnd}
              onChange={e => setFilter('end', e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Category</label>
            <select className="form-select" value={activeCategory}
              onChange={e => setFilter('category', e.target.value)}>
              <option value="">All</option>
              {CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={clearAllFilters}>Clear</button>
        </div>
      )}

      {/* Summary bar */}
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
                    {hasActiveFilters ? 'No expenses match the current filters.' : 'No expenses yet. Click "Add" to start tracking.'}
                  </td></tr>
                ) : expenses.map(e => (
                  editingId === e.id ? (
                    <tr key={e.id} className="inline-edit-row">
                      <td>
                        <input className="inline-edit-input" type="date" value={editForm.expense_date}
                          onChange={ev => setEditForm({ ...editForm, expense_date: ev.target.value })} />
                      </td>
                      <td>
                        <span className={`user-pill ${getUserClass(e.user_name)}`}>{e.user_name}</span>
                      </td>
                      <td>
                        <select className="inline-edit-select" value={editForm.category}
                          onChange={ev => setEditForm({ ...editForm, category: ev.target.value })}>
                          {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                        </select>
                      </td>
                      <td>
                        <input className="inline-edit-input" type="text" value={editForm.description}
                          onChange={ev => setEditForm({ ...editForm, description: ev.target.value })}
                          placeholder="Description" />
                      </td>
                      <td>
                        <input className="inline-edit-input" type="number" step="0.01" value={editForm.amount}
                          onChange={ev => setEditForm({ ...editForm, amount: ev.target.value })}
                          style={{ width: 100 }} />
                      </td>
                      <td>
                        <span className={`tag ${e.entry_type === 'estimated' ? 'tag-yellow' : 'tag-green'}`}>
                          {e.entry_type === 'estimated' ? 'Est.' : 'Actual'}
                        </span>
                      </td>
                      <td>
                        <div className="inline-edit-actions">
                          <button className="save-btn" onClick={saveEdit} title="Save"><Check size={14} /></button>
                          <button className="cancel-btn" onClick={cancelEdit} title="Cancel"><X size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={e.id}>
                      <td>{e.expense_date}</td>
                      <td>
                        <span className={`user-pill ${getUserClass(e.user_name)} clickable`} onClick={() => filterByUser(e.user_id)}>
                          {e.user_name}
                        </span>
                      </td>
                      <td>
                        <span className="tag clickable" onClick={() => filterByCategory(e.category)}
                          style={{ background: `${getCategoryColor(e.category)}22`, color: getCategoryColor(e.category) }}>
                          {e.category}
                        </span>
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
                        <div style={{ display: 'flex', gap: '0.25rem' }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => startEdit(e)} title="Edit">
                            <Edit3 size={14} />
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(e.id)} title="Delete">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
