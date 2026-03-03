import React, { useState, useEffect, useRef } from 'react';
import { getDashboard, getInsights, getLatestAdvice, addExpense, extractScreenshot, importScreenshot, getDailySpending } from '../api';
import { useAuth } from '../context/AuthContext';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, ReferenceLine, AreaChart, Area } from 'recharts';
import { useNavigate } from 'react-router-dom';
import { Plus, Zap, TrendingUp, Users, DollarSign, AlertTriangle, CheckCircle, ArrowUpRight, Camera, Upload, X, Edit3 } from 'lucide-react';
import { CATEGORIES, getCategoryColor, getUserColor, getUserClass } from '../categoryColors';

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function fmtMoney2(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [insights, setInsights] = useState(null);
  const [advice, setAdvice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dismissedBanner, setDismissedBanner] = useState(false);

  // Quick add form
  const [category, setCategory] = useState('Groceries');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().split('T')[0]);
  const [adding, setAdding] = useState(false);
  const [addedMsg, setAddedMsg] = useState('');
  const amountRef = useRef(null);

  // Daily spending range
  const [spendingRange, setSpendingRange] = useState(14);
  const [spendingData, setSpendingData] = useState(null);
  const [spendingLoading, setSpendingLoading] = useState(false);

  // Screenshot upload
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState(null); // { transactions: [...] }
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const fileInputRef = useRef(null);

  function loadAll() {
    Promise.all([getDashboard(), getInsights(), getLatestAdvice('nightly')])
      .then(([d, i, a]) => { setData(d); setInsights(i); setAdvice(a); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadAll(); }, []);

  useEffect(() => {
    if (spendingRange === 14) {
      setSpendingData(null); // use default insights data
      return;
    }
    setSpendingLoading(true);
    getDailySpending(spendingRange)
      .then(r => setSpendingData(r.daily_spending))
      .catch(console.error)
      .finally(() => setSpendingLoading(false));
  }, [spendingRange]);

  async function handleQuickAdd(e) {
    e.preventDefault();
    if (!amount || parseFloat(amount) <= 0) return;
    setAdding(true);
    try {
      await addExpense({
        category, amount: parseFloat(amount), description: description || category,
        expense_date: expenseDate, entry_type: 'actual', is_range: false, recurring: false
      });
      setAddedMsg(`${category} ${fmtMoney2(parseFloat(amount))}`);
      setAmount(''); setDescription('');
      setTimeout(() => setAddedMsg(''), 3000);
      Promise.all([getDashboard(), getInsights()])
        .then(([d, i]) => { setData(d); setInsights(i); });
      amountRef.current?.focus();
    } catch (err) { alert(err.message); }
    setAdding(false);
  }

  async function handleScreenshot(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setExtracting(true);
    setExtracted(null);
    setImportResult(null);

    try {
      const allTransactions = [];
      for (const file of files) {
        const base64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(file);
        });
        const mediaType = file.type || 'image/png';
        const result = await extractScreenshot(base64, mediaType);
        if (result.transactions) allTransactions.push(...result.transactions);
      }
      setExtracted({ transactions: allTransactions });
    } catch (err) {
      alert('Error extracting transactions: ' + err.message);
    }
    setExtracting(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function updateExtractedTxn(index, field, value) {
    setExtracted(prev => {
      const updated = [...prev.transactions];
      updated[index] = { ...updated[index], [field]: field === 'amount' ? parseFloat(value) || 0 : value };
      return { transactions: updated };
    });
  }

  function removeExtractedTxn(index) {
    setExtracted(prev => ({
      transactions: prev.transactions.filter((_, i) => i !== index)
    }));
  }

  async function handleImportExtracted() {
    if (!extracted?.transactions?.length) return;
    setImporting(true);
    try {
      const result = await importScreenshot(extracted.transactions);
      setImportResult(result);
      setExtracted(null);
      Promise.all([getDashboard(), getInsights()])
        .then(([d, i]) => { setData(d); setInsights(i); });
      setTimeout(() => setImportResult(null), 5000);
    } catch (err) { alert('Import error: ' + err.message); }
    setImporting(false);
  }

  if (loading) return <div className="loading-page"><div className="spinner" /> Loading dashboard...</div>;
  if (!data) return <div>Failed to load dashboard</div>;

  const netSavings = data.monthly_income - data.monthly_expenses - data.mortgage_monthly;
  const totalAssets = (data.balances.offset || 0) + (data.balances.savings || 0) + (data.balances.investment || 0);
  const estimatedIncome = data.estimated_monthly_income || 0;
  const budgetedExpenses = data.budgeted_expenses || 0;
  const expenseDiff = budgetedExpenses - data.monthly_expenses;

  const budgetComparison = (data.budget_by_category || []).map(b => {
    const expRow = data.expenses_by_category.find(e => e.category === b.category);
    return {
      category: b.category, budget: b.budget,
      actual: expRow ? expRow.total : 0,
      remaining: b.budget - (expRow ? expRow.total : 0)
    };
  }).sort((a, b) => b.actual - a.actual).filter(b => b.actual > 0 || b.budget > 0);

  const pace = insights?.spending_pace;
  const pacePercent = pace && pace.monthly_budget > 0 ? Math.round((pace.projected_monthly / pace.monthly_budget) * 100) : 0;
  const offsetIns = insights?.offset_insights;

  // Weekly trend summary numbers
  const thisWeek = data.weekly_trend?.[data.weekly_trend.length - 1]?.total || 0;
  const lastWeek = data.weekly_trend?.[data.weekly_trend.length - 2]?.total || 0;
  const weekChange = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : 0;

  // Corgi budget check
  const dailyBudget = pace?.monthly_budget ? pace.monthly_budget / 30 : 0;
  const weeklyBudget = data.weekly_budget || 0;
  const isUnderBudget = pacePercent > 0 && pacePercent <= 100;
  const isOverBudget = pacePercent > 100;

  return (
    <div>
      {/* ===== CORGI MASCOT ===== */}
      {pace && (isUnderBudget || isOverBudget) && (
        <div className={`corgi-mascot ${isUnderBudget ? 'happy' : 'sad'}`}>
          <div className="corgi-icon">
            <svg viewBox="0 0 64 64" width="48" height="48" className="corgi-svg">
              {/* Corgi body */}
              <ellipse cx="32" cy="42" rx="18" ry="10" fill={isUnderBudget ? '#f0c36d' : '#d4a84b'} />
              {/* Corgi butt (fluffy) */}
              <ellipse cx="48" cy="42" rx="6" ry="8" fill={isUnderBudget ? '#e8b85a' : '#c99a3d'} />
              {/* Tail */}
              <path d={isUnderBudget ? 'M52 36 Q58 28 56 22' : 'M52 42 Q56 46 54 50'} stroke={isUnderBudget ? '#d4a030' : '#c99a3d'} strokeWidth="3" fill="none" strokeLinecap="round" className={isUnderBudget ? 'corgi-tail-wag' : ''} />
              {/* Front legs */}
              <rect x="20" y="48" width="4" height="10" rx="2" fill={isUnderBudget ? '#f0c36d' : '#d4a84b'} />
              <rect x="28" y="48" width="4" height="10" rx="2" fill={isUnderBudget ? '#f0c36d' : '#d4a84b'} />
              {/* Back legs */}
              <rect x="38" y="48" width="4" height="10" rx="2" fill={isUnderBudget ? '#e8b85a' : '#c99a3d'} />
              <rect x="44" y="48" width="4" height="10" rx="2" fill={isUnderBudget ? '#e8b85a' : '#c99a3d'} />
              {/* Head */}
              <circle cx="16" cy="32" r="12" fill={isUnderBudget ? '#f0c36d' : '#d4a84b'} />
              {/* Ears */}
              <ellipse cx="8" cy="22" rx="5" ry="8" fill={isUnderBudget ? '#d4a030' : '#b8892e'} transform="rotate(-15 8 22)" />
              <ellipse cx="24" cy="22" rx="5" ry="8" fill={isUnderBudget ? '#d4a030' : '#b8892e'} transform="rotate(15 24 22)" />
              {/* Inner ears */}
              <ellipse cx="8" cy="23" rx="3" ry="5" fill="#f5d6a0" transform="rotate(-15 8 23)" />
              <ellipse cx="24" cy="23" rx="3" ry="5" fill="#f5d6a0" transform="rotate(15 24 23)" />
              {/* White face marking */}
              <ellipse cx="16" cy="36" rx="6" ry="5" fill="#fff5e0" />
              {/* Eyes */}
              {isUnderBudget ? (
                <>
                  <circle cx="12" cy="30" r="2.5" fill="#2d3436" />
                  <circle cx="20" cy="30" r="2.5" fill="#2d3436" />
                  <circle cx="12.8" cy="29.2" r="0.8" fill="white" />
                  <circle cx="20.8" cy="29.2" r="0.8" fill="white" />
                </>
              ) : (
                <>
                  {/* Sad eyes - slightly droopy */}
                  <ellipse cx="12" cy="31" rx="2.5" ry="2" fill="#2d3436" />
                  <ellipse cx="20" cy="31" rx="2.5" ry="2" fill="#2d3436" />
                  <line x1="9" y1="28" x2="13" y2="29.5" stroke="#2d3436" strokeWidth="1" strokeLinecap="round" />
                  <line x1="23" y1="28" x2="19" y2="29.5" stroke="#2d3436" strokeWidth="1" strokeLinecap="round" />
                </>
              )}
              {/* Nose */}
              <ellipse cx="16" cy="35" rx="2" ry="1.5" fill="#2d3436" />
              {/* Mouth */}
              {isUnderBudget ? (
                <path d="M13 37 Q16 40 19 37" stroke="#2d3436" strokeWidth="1" fill="none" strokeLinecap="round" />
              ) : (
                <path d="M13 39 Q16 37 19 39" stroke="#2d3436" strokeWidth="1" fill="none" strokeLinecap="round" />
              )}
              {/* Tongue (happy only) */}
              {isUnderBudget && <ellipse cx="16" cy="40" rx="2" ry="2.5" fill="#ff7675" />}
              {/* White chest */}
              <ellipse cx="22" cy="44" rx="5" ry="4" fill="#fff5e0" />
            </svg>
          </div>
          <div className="corgi-msg">
            {isUnderBudget ? (
              <>
                <strong>Woof! Great job!</strong> You're <strong>{100 - pacePercent}% under budget</strong> this month!
                {weekChange < 0 && ` Spending dropped ${Math.abs(weekChange)}% vs last week too.`}
                {' '}Keep it up!
              </>
            ) : (
              <>
                <strong>Ruff...</strong> You're <strong>{pacePercent - 100}% over budget</strong> this month.
                {pace.daily_average > dailyBudget && ` Daily spend (${fmtMoney(pace.daily_average)}) exceeds target (${fmtMoney(dailyBudget)}).`}
                {' '}Let's rein it in!
              </>
            )}
          </div>
        </div>
      )}

      {/* ===== ARUTO TRANSACTION BANNER ===== */}
      {user?.username === 'aruto' && !dismissedBanner && (
        <div className="aruto-banner">
          <Camera size={18} />
          <div className="aruto-banner-text">
            <strong>Hey Aruto!</strong> Screenshot your last month of transactions from your bank app and upload them below — Claude will automatically read and categorise everything.
          </div>
          <button className="aruto-banner-dismiss" onClick={() => setDismissedBanner(true)}>&times;</button>
        </div>
      )}

      {/* ===== COMPACT WEEKLY OVERVIEW (top bar) ===== */}
      <div className="week-overview">
        <div className="week-overview-chart">
          <ResponsiveContainer width="100%" height={80}>
            <BarChart data={data.weekly_trend} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <XAxis dataKey="week" tick={{ fill: '#8b8fa3', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip
                contentStyle={{ background: '#1a1d27', border: '1px solid #2d3148', borderRadius: 8, fontSize: '0.8rem' }}
                formatter={(v) => [fmtMoney(v), 'Spent']}
              />
              {data.weekly_budget > 0 && (
                <ReferenceLine y={data.weekly_budget} stroke="#00cec9" strokeDasharray="3 3" strokeWidth={1} />
              )}
              <Bar dataKey="total" fill="#6c5ce7" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="week-overview-stats">
          <div className="week-stat">
            <span className="week-stat-label">This Week</span>
            <span className="week-stat-value">{fmtMoney(thisWeek)}</span>
          </div>
          <div className="week-stat">
            <span className="week-stat-label">Last Week</span>
            <span className="week-stat-value" style={{ color: 'var(--text-muted)' }}>{fmtMoney(lastWeek)}</span>
          </div>
          <div className="week-stat">
            <span className="week-stat-label">Change</span>
            <span className="week-stat-value" style={{ color: weekChange <= 0 ? 'var(--green)' : 'var(--red)' }}>
              {weekChange > 0 ? '+' : ''}{weekChange}%
            </span>
          </div>
          <div className="week-stat">
            <span className="week-stat-label">Budget/wk</span>
            <span className="week-stat-value" style={{ color: 'var(--blue)' }}>{fmtMoney(data.weekly_budget)}</span>
          </div>
        </div>
      </div>

      {/* ===== QUICK ADD EXPENSE ===== */}
      <div className="quick-add-card">
        <form onSubmit={handleQuickAdd} className="quick-add-form">
          <div className="quick-add-label">
            <Plus size={18} />
            <span>Quick Add</span>
          </div>
          <select className="quick-add-select" value={category} onChange={e => setCategory(e.target.value)}>
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
          <div className="quick-add-amount">
            <span className="quick-add-dollar">$</span>
            <input ref={amountRef} type="number" step="0.01" placeholder="0.00"
              value={amount} onChange={e => setAmount(e.target.value)} required />
          </div>
          <input className="quick-add-desc" type="text" placeholder="What for? (optional)"
            value={description} onChange={e => setDescription(e.target.value)} />
          <input className="quick-add-date" type="date" value={expenseDate}
            onChange={e => setExpenseDate(e.target.value)} />
          <button className="btn btn-primary quick-add-btn" type="submit" disabled={adding}>
            {adding ? '...' : 'Add'}
          </button>
        </form>
        {addedMsg && <div className="quick-add-confirm"><CheckCircle size={14} /> Added: {addedMsg}</div>}
        {insights?.recent_expenses?.length > 0 && (
          <div className="quick-add-recent">
            {insights.recent_expenses.slice(0, 4).map((e, i) => (
              <span key={i} className="recent-pill">
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: getCategoryColor(e.category), display: 'inline-block' }} />
                {e.category} <strong>{fmtMoney2(e.amount)}</strong>
                <span className="recent-who" style={{ color: getUserColor(e.user_name) }}>{e.user_name}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ===== SCREENSHOT UPLOAD ===== */}
      <div className="screenshot-upload-card">
        <div className="screenshot-upload-header">
          <Camera size={16} />
          <span>Import from Screenshot</span>
          <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleScreenshot}
            style={{ display: 'none' }} />
          <button className="btn btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()}
            disabled={extracting}>
            <Upload size={14} /> {extracting ? 'Reading...' : 'Upload'}
          </button>
        </div>
        {extracting && (
          <div className="screenshot-extracting">
            <div className="spinner" /> Claude is reading your screenshot...
          </div>
        )}
        {importResult && (
          <div className="quick-add-confirm">
            <CheckCircle size={14} /> Imported {importResult.added} transaction{importResult.added !== 1 ? 's' : ''}
            {importResult.skipped > 0 && ` (${importResult.skipped} duplicates skipped)`}
          </div>
        )}
        {extracted?.transactions?.length > 0 && (
          <div className="screenshot-review">
            <div className="screenshot-review-header">
              <span>{extracted.transactions.length} transactions found — review &amp; confirm:</span>
            </div>
            <div className="screenshot-txn-list">
              {extracted.transactions.map((t, i) => (
                <div key={i} className="screenshot-txn-row">
                  <input className="screenshot-txn-date" type="text" value={t.date}
                    onChange={e => updateExtractedTxn(i, 'date', e.target.value)} />
                  <input className="screenshot-txn-desc" type="text" value={t.description}
                    onChange={e => updateExtractedTxn(i, 'description', e.target.value)} />
                  <div className="screenshot-txn-amount">
                    <span>$</span>
                    <input type="number" step="0.01" value={t.amount}
                      onChange={e => updateExtractedTxn(i, 'amount', e.target.value)} />
                  </div>
                  <select className="screenshot-txn-cat" value={t.category}
                    onChange={e => updateExtractedTxn(i, 'category', e.target.value)}>
                    {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                  </select>
                  <button className="screenshot-txn-remove" onClick={() => removeExtractedTxn(i)}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="screenshot-review-actions">
              <button className="btn btn-primary" onClick={handleImportExtracted} disabled={importing}>
                {importing ? 'Importing...' : `Import ${extracted.transactions.length} Transactions`}
              </button>
              <button className="btn btn-ghost" onClick={() => setExtracted(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* ===== HOUSEHOLD PULSE + SPENDING PACE ===== */}
      <div className="grid-2" style={{ marginBottom: '1rem' }}>
        <div className="card pulse-card">
          <div className="card-title"><Users size={14} /> Household Pulse</div>
          {insights?.user_activity?.map(u => {
            const isStale = u.days_since_last > 3;
            const isActive = u.days_since_last !== null && u.days_since_last <= 1;
            return (
              <div key={u.user_id} className="pulse-user clickable"
                onClick={() => navigate(`/expenses?user_id=${u.user_id}`)}>
                <div className="pulse-avatar" style={{ background: getUserColor(u.display_name) }}>{u.display_name[0]}</div>
                <div className="pulse-info">
                  <div className="pulse-name">
                    {u.display_name}
                    {isActive && <span className="pulse-badge pulse-badge-green">Active</span>}
                    {isStale && <span className="pulse-badge pulse-badge-red">Needs logging</span>}
                  </div>
                  <div className="pulse-stats">
                    {u.month_count} entries ({fmtMoney(u.month_total)})
                    {u.days_since_last !== null
                      ? <span> · {u.days_since_last === 0 ? 'Today' : u.days_since_last === 1 ? 'Yesterday' : `${u.days_since_last}d ago`}</span>
                      : <span> · No entries yet</span>}
                    {u.streak > 2 && <span className="pulse-streak"> · {u.streak}d streak</span>}
                  </div>
                </div>
              </div>
            );
          })}
          {insights?.user_activity?.some(u => u.days_since_last > 3) && (
            <div className="pulse-nudge">
              <AlertTriangle size={14} />
              Reminder: Log expenses regularly for accurate tracking
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title"><Zap size={14} /> Spending Pace</div>
          {pace && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '1.5rem', fontWeight: 700, color: pacePercent > 110 ? 'var(--red)' : pacePercent > 90 ? 'var(--yellow)' : 'var(--green)' }}>
                  {fmtMoney(pace.daily_average)}/day
                </span>
                <div style={{ textAlign: 'right', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  Projected: {fmtMoney(pace.projected_monthly)}/mo<br />
                  Budget: {fmtMoney(pace.monthly_budget)}/mo
                </div>
              </div>
              <div className="progress-bar" style={{ height: 12, marginBottom: '0.5rem' }}>
                <div className={`progress-fill ${pacePercent <= 90 ? 'green' : pacePercent <= 110 ? 'yellow' : 'red'}`}
                  style={{ width: `${Math.min(100, pacePercent)}%` }} />
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                <span>{fmtMoney(pace.total_spent)} spent in {pace.days_elapsed} days</span>
                <span style={{ fontWeight: 600, color: pacePercent <= 100 ? 'var(--green)' : 'var(--red)' }}>
                  {pacePercent <= 100 ? `${100 - pacePercent}% under budget` : `${pacePercent - 100}% over budget`}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ===== KEY STATS ===== */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Monthly Income</div>
          <div className={`stat-value ${data.monthly_income > 0 ? 'positive' : 'neutral'}`}>{fmtMoney(data.monthly_income)}</div>
          <div className="card-sub">{estimatedIncome > 0 ? `Expected: ${fmtMoney(estimatedIncome)}` : 'Combined take-home'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Monthly Expenses</div>
          <div className="stat-value negative">{fmtMoney(data.monthly_expenses)}</div>
          <div className="card-sub">
            Budget: {fmtMoney(budgetedExpenses)}
            {data.monthly_expenses > 0 && (
              expenseDiff >= 0
                ? <span style={{ color: 'var(--green)', marginLeft: 6 }}>({fmtMoney(expenseDiff)} under)</span>
                : <span style={{ color: 'var(--red)', marginLeft: 6 }}>({fmtMoney(Math.abs(expenseDiff))} over)</span>
            )}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Mortgage</div>
          <div className="stat-value warning">{fmtMoney(data.mortgage_monthly)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Net Position</div>
          <div className={`stat-value ${netSavings >= 0 ? 'positive' : 'negative'}`}>
            {netSavings >= 0 ? '+' : ''}{fmtMoney(netSavings)}
          </div>
          <div className="card-sub">{netSavings >= 0 ? 'Surplus this month' : 'Deficit this month'}</div>
        </div>
      </div>

      {/* ===== OFFSET ACCOUNT ===== */}
      {offsetIns && (
        <div className="card offset-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
            <div>
              <div className="card-title" style={{ marginBottom: '0.25rem' }}><DollarSign size={14} /> Offset Account</div>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--green)' }}>{fmtMoney(offsetIns.balance)}</div>
            </div>
            <div className="offset-stats">
              <div className="offset-stat">
                <span className="offset-stat-label">Saved/mo</span>
                <span className="offset-stat-value">{fmtMoney(offsetIns.monthly_interest_saved)}</span>
              </div>
              <div className="offset-stat">
                <span className="offset-stat-label">Saved/yr</span>
                <span className="offset-stat-value">{fmtMoney(offsetIns.annual_interest_saved)}</span>
              </div>
              <div className="offset-stat">
                <span className="offset-stat-label">Rate</span>
                <span className="offset-stat-value">{(offsetIns.mortgage_rate * 100).toFixed(1)}%</span>
              </div>
            </div>
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
            <ArrowUpRight size={12} style={{ verticalAlign: 'middle' }} /> Every $10k extra in offset saves ~{fmtMoney(Math.round(10000 * offsetIns.mortgage_rate))}/yr interest
          </div>
        </div>
      )}

      {/* ===== DAILY SPENDING ===== */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <div className="card-title" style={{ margin: 0 }}>Daily Spending</div>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {[
              { label: '2W', days: 14 },
              { label: '1M', days: 30 },
              { label: '3M', days: 90 },
              { label: '6M', days: 180 },
              { label: '1Y', days: 365 },
            ].map(r => (
              <button key={r.days}
                className={`btn btn-sm ${spendingRange === r.days ? 'btn-primary' : 'btn-ghost'}`}
                style={{ padding: '2px 8px', fontSize: '0.7rem', minWidth: 32 }}
                onClick={() => setSpendingRange(r.days)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
        {spendingLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}><div className="spinner" /></div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={spendingData || insights?.daily_spending || []}>
              <XAxis dataKey="date" tick={{ fill: '#8b8fa3', fontSize: 10 }}
                interval={spendingRange > 60 ? Math.floor(spendingRange / 15) : spendingRange > 30 ? 2 : 0} />
              <YAxis tick={{ fill: '#8b8fa3', fontSize: 10 }} />
              <Tooltip contentStyle={{ background: '#1a1d27', border: '1px solid #2d3148', borderRadius: 8 }}
                formatter={(v) => [fmtMoney(v), 'Spent']} />
              <Area type="monotone" dataKey="total" stroke="#6c5ce7" fill="rgba(108,92,231,0.2)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ===== BY CATEGORY ===== */}
      <div className="card">
        <div className="card-title">By Category</div>
        {data.expenses_by_category.length > 0 ? (
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={data.expenses_by_category} dataKey="total" nameKey="category"
                cx="50%" cy="50%" outerRadius={90} innerRadius={40}
                label={({ category, total, percent }) => `${category} $${total.toFixed(0)} (${(percent * 100).toFixed(0)}%)`}
                labelLine={{ stroke: '#8b8fa3', strokeWidth: 0.5 }}>
                {data.expenses_by_category.map((entry, i) => <Cell key={i} fill={getCategoryColor(entry.category)} />)}
              </Pie>
              <Tooltip formatter={(v) => '$' + v.toFixed(0)} />
            </PieChart>
          </ResponsiveContainer>
        ) : <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No expenses yet.</p>}
      </div>

      {/* ===== BUDGET TRACKER ===== */}
      {budgetComparison.length > 0 && (
        <div className="card">
          <div className="card-title">Budget Tracker</div>
          <div className="budget-bars">
            {budgetComparison.map(b => {
              const pct = b.budget > 0 ? (b.actual / b.budget) * 100 : 0;
              return (
                <div key={b.category} className="budget-bar-row clickable"
                  onClick={() => navigate(`/expenses?category=${encodeURIComponent(b.category)}`)}>
                  <div className="budget-bar-label">
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: getCategoryColor(b.category), display: 'inline-block' }} />
                      {b.category}
                    </span>
                    <span>
                      <strong style={{ color: b.actual > b.budget ? 'var(--red)' : 'var(--text)' }}>{fmtMoney(b.actual)}</strong>
                      <span style={{ color: 'var(--text-muted)' }}> / {fmtMoney(b.budget)}</span>
                    </span>
                  </div>
                  <div className="progress-bar" style={{ height: 8, margin: '2px 0' }}>
                    <div className={`progress-fill ${pct <= 75 ? 'green' : pct <= 100 ? 'yellow' : 'red'}`}
                      style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ===== BIGGEST SPENDS ===== */}
      <div className="card">
        <div className="card-title">Biggest Spends (30 days)</div>
        {insights?.biggest_expenses?.map((e, i) => (
          <div key={i} className="big-spend-row clickable"
            onClick={() => navigate(`/expenses?category=${encodeURIComponent(e.category)}`)}>
            <div className="big-spend-rank">#{i + 1}</div>
            <div className="big-spend-info">
              <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{e.description || e.category}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{e.category} · {e.expense_date} · {e.user_name}</div>
            </div>
            <div className="big-spend-amount">{fmtMoney(e.amount)}</div>
          </div>
        ))}
      </div>

      {/* ===== SAVINGS GOALS ===== */}
      {data.goals?.length > 0 && (
        <div className="card">
          <div className="card-title">Savings Goals</div>
          {data.goals.map(g => {
            const pct = g.target_amount > 0 ? Math.min(100, (g.current_amount / g.target_amount) * 100) : 0;
            return (
              <div key={g.id} style={{ marginBottom: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
                  <span style={{ fontWeight: 600 }}>{g.name}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{fmtMoney(g.current_amount)} / {fmtMoney(g.target_amount)} ({pct.toFixed(0)}%)</span>
                </div>
                <div className="progress-bar">
                  <div className={`progress-fill ${pct >= 75 ? 'green' : pct >= 40 ? 'yellow' : ''}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ===== ACCOUNT BALANCES ===== */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Savings</div>
          <div className="stat-value neutral">{fmtMoney(data.balances.savings)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Credit Card</div>
          <div className={`stat-value ${data.balances.credit_card > 0 ? 'negative' : 'positive'}`}>{fmtMoney(data.balances.credit_card)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Investments</div>
          <div className="stat-value neutral">{fmtMoney(data.balances.investment)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total Assets</div>
          <div className="stat-value positive">{fmtMoney(totalAssets)}</div>
        </div>
      </div>

      {advice?.content && (
        <div className="advice-box">
          <h3>Claude's Latest Summary</h3>
          {advice.content}
        </div>
      )}
    </div>
  );
}
