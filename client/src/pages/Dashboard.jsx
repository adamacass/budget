import React, { useState, useEffect, useRef } from 'react';
import { getDashboard, getInsights, addExpense, extractScreenshot, importScreenshot, getDailySpending } from '../api';
import { useAuth } from '../context/AuthContext';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, ReferenceLine, AreaChart, Area, ReferenceArea, LineChart, Line, CartesianGrid, ComposedChart, Legend } from 'recharts';
import { useNavigate } from 'react-router-dom';
import { Plus, Zap, TrendingUp, Users, DollarSign, AlertTriangle, CheckCircle, ArrowUpRight, Camera, Upload, X, Target, Shield } from 'lucide-react';
import { CATEGORIES, getCategoryColor, getUserColor, getUserClass } from '../categoryColors';

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function fmtMoney2(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtK(n) { return n >= 10000 ? '$' + (n / 1000).toFixed(0) + 'k' : fmtMoney(n); }

function MortgageProjectionChart({ mortgageConfig: mc, offsetBalance, monthlySurplus, mortgagePayment }) {
  const [savingsOverride, setSavingsOverride] = useState('');
  const [rateOverride, setRateOverride] = useState('');
  const [withdrawal, setWithdrawal] = useState('');
  const [horizon, setHorizon] = useState(10);

  const rate = (parseFloat(rateOverride) || mc.ratePercent || 6.24) / 100;
  const monthlyRate = rate / 12;
  const payment = mc.monthlyPayment || mortgagePayment || 4656.64;
  const termMonths = (mc.termYears || 30) * 12;

  const principal = monthlyRate > 0
    ? payment * (1 - Math.pow(1 + monthlyRate, -termMonths)) / monthlyRate
    : payment * termMonths;

  const mortgageStart = new Date((mc.startDate || '2025-11-23') + 'T00:00:00');
  const now = new Date();
  const monthsElapsed = (now.getFullYear() - mortgageStart.getFullYear()) * 12 + (now.getMonth() - mortgageStart.getMonth());

  let currentBalance = principal;
  for (let m = 0; m < monthsElapsed && currentBalance > 0; m++) {
    const interest = currentBalance * monthlyRate;
    currentBalance -= Math.min(payment - interest, currentBalance);
  }

  const monthlySavings = savingsOverride !== '' ? parseFloat(savingsOverride) || 0 : monthlySurplus;
  const netMonthlyGrowth = monthlySavings - payment;
  const lumpWithdrawal = parseFloat(withdrawal) || 0;

  const projData = [];
  let projBal = currentBalance;
  let projOff = Math.max(0, offsetBalance - lumpWithdrawal);
  let balNoOff = currentBalance;
  let payoffMonth = null;

  for (let m = 0; m <= horizon * 12; m++) {
    const date = new Date(); date.setMonth(date.getMonth() + m);
    const label = date.toISOString().substring(0, 7);

    if (m > 0) {
      if (balNoOff > 0) {
        const intNo = balNoOff * monthlyRate;
        balNoOff = Math.max(0, balNoOff - Math.min(payment - intNo, balNoOff));
      }
      if (projBal > 0) {
        const effBal = Math.max(0, projBal - projOff);
        const interest = effBal * monthlyRate;
        projBal = Math.max(0, projBal - Math.min(payment - interest, projBal));
        projOff = Math.max(0, projOff + monthlySavings - payment);
        if (projBal <= 0 && !payoffMonth) payoffMonth = m;
      }
    }

    if (m % (horizon <= 5 ? 1 : horizon <= 15 ? 3 : 6) === 0 || m === horizon * 12) {
      projData.push({ month: label, offset: Math.round(projOff), mortgage: Math.round(projBal), no_offset: Math.round(balNoOff) });
    }
  }

  const origPayoff = new Date(mortgageStart); origPayoff.setMonth(origPayoff.getMonth() + termMonths);
  const projPayoff = payoffMonth ? new Date(new Date().setMonth(new Date().getMonth() + payoffMonth)) : origPayoff;
  const timeSavedMonths = payoffMonth ? Math.max(0, (termMonths - monthsElapsed) - payoffMonth) : 0;
  const timeSavedYr = Math.floor(timeSavedMonths / 12);
  const timeSavedMo = timeSavedMonths % 12;

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <div className="card-title" style={{ margin: 0 }}>
          <TrendingUp size={14} /> Offset vs Mortgage
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {[5, 10, 15, 20, 30].map(y => (
            <button key={y} className={`btn btn-sm ${horizon === y ? 'btn-primary' : 'btn-ghost'}`}
              style={{ padding: '2px 8px', fontSize: '0.7rem' }}
              onClick={() => setHorizon(y)}>{y}yr</button>
          ))}
        </div>
      </div>

      {/* Summary stats */}
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.75rem', fontSize: '0.8rem' }}>
        <div><span style={{ color: 'var(--text-muted)' }}>Payoff: </span>
          <strong style={{ color: 'var(--green)' }}>{projPayoff.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })}</strong>
          <span style={{ color: 'var(--text-muted)' }}> (was {origPayoff.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })})</span>
        </div>
        {timeSavedMonths > 0 && <div><span style={{ color: 'var(--text-muted)' }}>Saving: </span>
          <strong style={{ color: 'var(--green)' }}>{timeSavedYr > 0 ? `${timeSavedYr}yr ${timeSavedMo}mo` : `${timeSavedMo}mo`}</strong>
        </div>}
        <div><span style={{ color: 'var(--text-muted)' }}>Net offset growth: </span>
          <strong style={{ color: netMonthlyGrowth >= 0 ? 'var(--green)' : 'var(--red)' }}>{netMonthlyGrowth >= 0 ? '+' : ''}{fmtMoney(netMonthlyGrowth)}/mo</strong>
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <div style={{ flex: '1 1 120px' }}>
          <label style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Monthly savings ($)</label>
          <input className="form-input" type="number" step="100"
            placeholder={`${Math.round(monthlySurplus)} (auto)`}
            value={savingsOverride}
            onChange={e => setSavingsOverride(e.target.value)}
            style={{ padding: '4px 8px', fontSize: '0.8rem' }} />
        </div>
        <div style={{ flex: '1 1 100px' }}>
          <label style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Interest rate (%)</label>
          <input className="form-input" type="number" step="0.01"
            placeholder={`${mc.ratePercent || 6.24} (current)`}
            value={rateOverride}
            onChange={e => setRateOverride(e.target.value)}
            style={{ padding: '4px 8px', fontSize: '0.8rem' }} />
        </div>
        <div style={{ flex: '1 1 120px' }}>
          <label style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Planned withdrawal ($)</label>
          <input className="form-input" type="number" step="1000"
            placeholder="0"
            value={withdrawal}
            onChange={e => setWithdrawal(e.target.value)}
            style={{ padding: '4px 8px', fontSize: '0.8rem' }} />
        </div>
        {(savingsOverride !== '' || rateOverride !== '' || withdrawal !== '') && (
          <div style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
            <button className="btn btn-ghost btn-sm" style={{ padding: '4px 8px', fontSize: '0.7rem' }}
              onClick={() => { setSavingsOverride(''); setRateOverride(''); setWithdrawal(''); }}>Reset</button>
          </div>
        )}
      </div>

      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={projData}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="month" tick={{ fill: '#8b8fa3', fontSize: 10 }} interval={Math.max(1, Math.floor(projData.length / 10))} />
          <YAxis tick={{ fill: '#8b8fa3', fontSize: 10 }} tickFormatter={v => fmtK(v)} />
          <Tooltip
            contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}
            formatter={(v, name) => [fmtMoney(v), name]}
          />
          <Legend />
          <Area type="monotone" dataKey="offset" stroke="#6c5ce7" fill="rgba(108,92,231,0.12)" strokeWidth={2} name="Offset" dot={false} />
          <Line type="monotone" dataKey="mortgage" stroke="#d63031" strokeWidth={2} name="Mortgage (with offset)" dot={false} />
          <Line type="monotone" dataKey="no_offset" stroke="#636e72" strokeWidth={1} strokeDasharray="6 3" name="Mortgage (no offset)" dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [insights, setInsights] = useState(null);
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
  // Core vs all spending toggle (default: core = excludes Insurance, Mortgage, Home)
  const [coreView, setCoreView] = useState(true);

  // Screenshot upload
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const fileInputRef = useRef(null);

  function loadAll() {
    Promise.all([getDashboard(), getInsights()])
      .then(([d, i]) => { setData(d); setInsights(i); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }

  function refreshData() {
    Promise.all([getDashboard(), getInsights()])
      .then(([d, i]) => { setData(d); setInsights(i); })
      .catch(console.error);
    if (spendingRange !== 14) {
      getDailySpending(spendingRange).then(r => setSpendingData(r.daily_spending)).catch(console.error);
    }
  }

  useEffect(() => { loadAll(); }, []);
  useEffect(() => {
    function onFocus() { if (data) refreshData(); }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  });

  useEffect(() => {
    if (spendingRange === 14) { setSpendingData(null); return; }
    setSpendingLoading(true);
    getDailySpending(spendingRange).then(r => setSpendingData(r.daily_spending)).catch(console.error).finally(() => setSpendingLoading(false));
  }, [spendingRange]);

  async function handleQuickAdd(e) {
    e.preventDefault();
    if (!amount || parseFloat(amount) <= 0) return;
    setAdding(true);
    try {
      await addExpense({ category, amount: parseFloat(amount), description: description || category, expense_date: expenseDate, entry_type: 'actual', is_range: false, recurring: false });
      setAddedMsg(`${category} ${fmtMoney2(parseFloat(amount))}`);
      setAmount(''); setDescription('');
      setTimeout(() => setAddedMsg(''), 3000);
      refreshData();
      amountRef.current?.focus();
    } catch (err) { alert(err.message); }
    setAdding(false);
  }

  async function handleScreenshot(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setExtracting(true); setExtracted(null); setImportResult(null);
    try {
      const allTransactions = [];
      for (const file of files) {
        const base64 = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(file); });
        const result = await extractScreenshot(base64, file.type || 'image/png');
        if (result.transactions) allTransactions.push(...result.transactions);
      }
      setExtracted({ transactions: allTransactions });
    } catch (err) { alert('Error: ' + err.message); }
    setExtracting(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function updateExtractedTxn(index, field, value) {
    setExtracted(prev => { const updated = [...prev.transactions]; updated[index] = { ...updated[index], [field]: field === 'amount' ? parseFloat(value) || 0 : value }; return { transactions: updated }; });
  }
  function removeExtractedTxn(index) { setExtracted(prev => ({ transactions: prev.transactions.filter((_, i) => i !== index) })); }

  async function handleImportExtracted() {
    if (!extracted?.transactions?.length) return;
    setImporting(true);
    try { const result = await importScreenshot(extracted.transactions); setImportResult(result); setExtracted(null); refreshData(); setTimeout(() => setImportResult(null), 5000); }
    catch (err) { alert('Import error: ' + err.message); }
    setImporting(false);
  }

  if (loading) return (
    <div className="loading-page corgi-loading">
      <svg viewBox="0 0 64 64" width="64" height="64" className="corgi-svg corgi-bounce">
        <ellipse cx="32" cy="42" rx="18" ry="10" fill="#f0c36d" />
        <ellipse cx="48" cy="42" rx="6" ry="8" fill="#e8b85a" />
        <path d="M52 36 Q58 28 56 22" stroke="#d4a030" strokeWidth="3" fill="none" strokeLinecap="round" className="corgi-tail-wag" />
        <rect x="20" y="48" width="4" height="10" rx="2" fill="#f0c36d" />
        <rect x="28" y="48" width="4" height="10" rx="2" fill="#f0c36d" />
        <rect x="38" y="48" width="4" height="10" rx="2" fill="#e8b85a" />
        <rect x="44" y="48" width="4" height="10" rx="2" fill="#e8b85a" />
        <circle cx="16" cy="32" r="12" fill="#f0c36d" />
        <ellipse cx="8" cy="22" rx="5" ry="8" fill="#d4a030" transform="rotate(-15 8 22)" />
        <ellipse cx="24" cy="22" rx="5" ry="8" fill="#d4a030" transform="rotate(15 24 22)" />
        <ellipse cx="16" cy="36" rx="6" ry="5" fill="#fff5e0" />
        <circle cx="12" cy="30" r="2.5" fill="#2d3436" /><circle cx="20" cy="30" r="2.5" fill="#2d3436" />
        <circle cx="12.8" cy="29.2" r="0.8" fill="white" /><circle cx="20.8" cy="29.2" r="0.8" fill="white" />
        <ellipse cx="16" cy="35" rx="2" ry="1.5" fill="#2d3436" />
        <path d="M13 37 Q16 40 19 37" stroke="#2d3436" strokeWidth="1" fill="none" strokeLinecap="round" />
      </svg>
      <div style={{ marginTop: '0.75rem', color: 'var(--text-muted)' }}>Fetching your budget...</div>
    </div>
  );
  if (!data) return <div>Failed to load dashboard</div>;

  const estimatedIncome = data.estimated_monthly_income || 0;
  const budgetedExpenses = data.budgeted_expenses || 0;
  const expenseDiff = budgetedExpenses - data.monthly_expenses;
  const monthlySurplus = data.monthly_surplus || (estimatedIncome - data.monthly_expenses);

  const budgetComparison = (data.budget_by_category || []).map(b => {
    const expRow = data.expenses_by_category.find(e => e.category === b.category);
    return { category: b.category, budget: b.budget, actual: expRow ? expRow.total : 0, remaining: b.budget - (expRow ? expRow.total : 0) };
  }).sort((a, b) => b.actual - a.actual).filter(b => b.actual > 0 || b.budget > 0);

  const pace = insights?.spending_pace;
  const pacePercent = pace && pace.monthly_budget > 0 ? Math.round((pace.projected_monthly / pace.monthly_budget) * 100) : 0;
  const offsetIns = insights?.offset_insights;
  const offsetBalance = offsetIns?.balance || data.balances?.offset || 0;

  const thisWeek = data.weekly_trend?.[data.weekly_trend.length - 1]?.total || 0;
  const lastWeek = data.weekly_trend?.[data.weekly_trend.length - 2]?.total || 0;
  const weekChange = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : 0;

  const dailyBudget = pace?.monthly_budget ? pace.monthly_budget / 30 : 0;
  const isUnderBudget = pacePercent > 0 && pacePercent <= 100;
  const isOverBudget = pacePercent > 100;

  // Goal buckets within offset
  const totalGoalAllocated = data.goals?.reduce((s, g) => s + (g.current_amount || 0), 0) || 0;
  const unallocatedOffset = offsetBalance - totalGoalAllocated;

  // Offset bucket colors
  const bucketColors = ['#6c5ce7', '#00cec9', '#fd79a8', '#fdcb6e', '#e17055', '#55efc4'];

  return (
    <div>
      {/* ===== CORGI MASCOT ===== */}
      {pace && (isUnderBudget || isOverBudget) && (
        <div className={`corgi-mascot ${isUnderBudget ? 'happy' : 'sad'}`}>
          <div className="corgi-icon">
            <svg viewBox="0 0 64 64" width="48" height="48" className="corgi-svg">
              <ellipse cx="32" cy="42" rx="18" ry="10" fill={isUnderBudget ? '#f0c36d' : '#d4a84b'} />
              <ellipse cx="48" cy="42" rx="6" ry="8" fill={isUnderBudget ? '#e8b85a' : '#c99a3d'} />
              <path d={isUnderBudget ? 'M52 36 Q58 28 56 22' : 'M52 42 Q56 46 54 50'} stroke={isUnderBudget ? '#d4a030' : '#c99a3d'} strokeWidth="3" fill="none" strokeLinecap="round" className={isUnderBudget ? 'corgi-tail-wag' : ''} />
              <rect x="20" y="48" width="4" height="10" rx="2" fill={isUnderBudget ? '#f0c36d' : '#d4a84b'} />
              <rect x="28" y="48" width="4" height="10" rx="2" fill={isUnderBudget ? '#f0c36d' : '#d4a84b'} />
              <rect x="38" y="48" width="4" height="10" rx="2" fill={isUnderBudget ? '#e8b85a' : '#c99a3d'} />
              <rect x="44" y="48" width="4" height="10" rx="2" fill={isUnderBudget ? '#e8b85a' : '#c99a3d'} />
              <circle cx="16" cy="32" r="12" fill={isUnderBudget ? '#f0c36d' : '#d4a84b'} />
              <ellipse cx="8" cy="22" rx="5" ry="8" fill={isUnderBudget ? '#d4a030' : '#b8892e'} transform="rotate(-15 8 22)" />
              <ellipse cx="24" cy="22" rx="5" ry="8" fill={isUnderBudget ? '#d4a030' : '#b8892e'} transform="rotate(15 24 22)" />
              <ellipse cx="8" cy="23" rx="3" ry="5" fill="#f5d6a0" transform="rotate(-15 8 23)" />
              <ellipse cx="24" cy="23" rx="3" ry="5" fill="#f5d6a0" transform="rotate(15 24 23)" />
              <ellipse cx="16" cy="36" rx="6" ry="5" fill="#fff5e0" />
              {isUnderBudget ? (
                <><circle cx="12" cy="30" r="2.5" fill="#2d3436" /><circle cx="20" cy="30" r="2.5" fill="#2d3436" /><circle cx="12.8" cy="29.2" r="0.8" fill="white" /><circle cx="20.8" cy="29.2" r="0.8" fill="white" /></>
              ) : (
                <><ellipse cx="12" cy="31" rx="2.5" ry="2" fill="#2d3436" /><ellipse cx="20" cy="31" rx="2.5" ry="2" fill="#2d3436" /><line x1="9" y1="28" x2="13" y2="29.5" stroke="#2d3436" strokeWidth="1" strokeLinecap="round" /><line x1="23" y1="28" x2="19" y2="29.5" stroke="#2d3436" strokeWidth="1" strokeLinecap="round" /></>
              )}
              <ellipse cx="16" cy="35" rx="2" ry="1.5" fill="#2d3436" />
              {isUnderBudget ? <path d="M13 37 Q16 40 19 37" stroke="#2d3436" strokeWidth="1" fill="none" strokeLinecap="round" /> : <path d="M13 39 Q16 37 19 39" stroke="#2d3436" strokeWidth="1" fill="none" strokeLinecap="round" />}
              {isUnderBudget && <ellipse cx="16" cy="40" rx="2" ry="2.5" fill="#ff7675" />}
              <ellipse cx="22" cy="44" rx="5" ry="4" fill="#fff5e0" />
            </svg>
          </div>
          <div className="corgi-msg">
            {isUnderBudget ? (
              <><strong>Woof!</strong> <strong>{100 - pacePercent}% under budget</strong> this month!{weekChange < 0 && ` Down ${Math.abs(weekChange)}% vs last week.`} Keep it up!</>
            ) : (
              <><strong>Ruff...</strong> <strong>{pacePercent - 100}% over budget</strong>.{pace.daily_average > dailyBudget && ` Spending ${fmtMoney(pace.daily_average)}/day vs ${fmtMoney(dailyBudget)} target.`} Let's rein it in!</>
            )}
          </div>
        </div>
      )}

      {/* ===== OFFSET HERO ===== */}
      <div className="offset-hero-card">
        <div className="offset-hero-top">
          <div className="offset-hero-balance">
            <div className="offset-hero-label"><DollarSign size={16} /> Offset Account</div>
            <div className="offset-hero-amount">{fmtMoney(offsetBalance)}</div>
            <div className="offset-hero-sub">
              Saving ~{fmtMoney(Math.round(offsetBalance * (data.mortgage_rate || 0.0624) / 12))}/mo in mortgage interest
            </div>
          </div>
          <div className="offset-hero-stats">
            <div className="offset-hero-stat">
              <span className="offset-hero-stat-value positive">+{fmtMoney(Math.max(0, monthlySurplus))}</span>
              <span className="offset-hero-stat-label">Surplus/mo</span>
            </div>
            <div className="offset-hero-stat">
              <span className="offset-hero-stat-value">{fmtMoney(data.mortgage_monthly)}</span>
              <span className="offset-hero-stat-label">Mortgage/mo</span>
            </div>
            <div className="offset-hero-stat">
              <span className="offset-hero-stat-value">{((data.mortgage_rate || 0.0624) * 100).toFixed(2)}%</span>
              <span className="offset-hero-stat-label">Rate</span>
            </div>
          </div>
        </div>

        {/* Goal buckets visualization */}
        {data.goals?.length > 0 && (
          <div className="offset-buckets">
            <div className="offset-bucket-bar">
              {data.goals.map((g, i) => {
                const widthPct = offsetBalance > 0 ? (g.current_amount / offsetBalance * 100) : 0;
                return widthPct > 0 ? (
                  <div key={g.id} className="offset-bucket-segment"
                    style={{ width: `${widthPct}%`, background: bucketColors[i % bucketColors.length] }}
                    title={`${g.name}: ${fmtMoney(g.current_amount)}`} />
                ) : null;
              })}
              {unallocatedOffset > 0 && offsetBalance > 0 && (
                <div className="offset-bucket-segment unallocated"
                  style={{ width: `${(unallocatedOffset / offsetBalance * 100)}%` }}
                  title={`Unallocated: ${fmtMoney(unallocatedOffset)}`} />
              )}
            </div>
            <div className="offset-bucket-legend">
              {data.goals.map((g, i) => {
                const pct = g.target_amount > 0 ? (g.current_amount / g.target_amount * 100) : 0;
                return (
                  <span key={g.id} className="offset-bucket-tag" onClick={() => navigate('/goals')}>
                    <span className="offset-bucket-dot" style={{ background: bucketColors[i % bucketColors.length] }} />
                    {g.name} <strong>{fmtK(g.current_amount)}</strong>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>({pct.toFixed(0)}%)</span>
                    {g.weekly_change !== null && g.weekly_change !== 0 && (
                      <span className={`goal-change-badge ${g.weekly_change > 0 ? 'positive' : 'negative'}`}>
                        {g.weekly_change > 0 ? '+' : ''}{fmtK(g.weekly_change)}
                      </span>
                    )}
                  </span>
                );
              })}
              {unallocatedOffset > 0 && (
                <span className="offset-bucket-tag">
                  <span className="offset-bucket-dot" style={{ background: 'var(--text-muted)', opacity: 0.4 }} />
                  Free <strong>{fmtK(unallocatedOffset)}</strong>
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ===== OFFSET BALANCE OVER TIME ===== */}
      {data.offset_history?.length > 1 && (
        <div className="card offset-history-card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <TrendingUp size={16} />
            <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>Offset Balance Over Time</span>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={data.offset_history} margin={{ top: 5, right: 10, bottom: 0, left: 10 }}>
              <defs>
                <linearGradient id="offsetGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                tickFormatter={d => { const [,m,day] = d.split('-'); return `${parseInt(day)}/${parseInt(m)}`; }}
                axisLine={false} tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                tickFormatter={v => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`}
                axisLine={false} tickLine={false}
                width={45}
                domain={['dataMin - 1000', 'dataMax + 1000']}
              />
              <Tooltip
                contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '0.8rem' }}
                formatter={(val) => [fmtMoney2(val), 'Balance']}
                labelFormatter={d => { const [y,m,day] = d.split('-'); return `${parseInt(day)}/${parseInt(m)}/${y}`; }}
              />
              <Area type="monotone" dataKey="balance" stroke="var(--accent)" strokeWidth={2} fill="url(#offsetGrad)" dot={false} activeDot={{ r: 4, fill: 'var(--accent)' }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ===== MORTGAGE PROJECTION CHART (interactive) ===== */}
      {data.mortgage_config && <MortgageProjectionChart
        mortgageConfig={data.mortgage_config}
        offsetBalance={offsetBalance}
        monthlySurplus={monthlySurplus}
        mortgagePayment={data.mortgage_monthly}
      />}

      {/* ===== ARUTO BANNER ===== */}
      {user?.username === 'aruto' && !dismissedBanner && (
        <div className="aruto-banner">
          <Camera size={18} />
          <div className="aruto-banner-text">
            <strong>Hey Aruto!</strong> Screenshot your bank transactions and upload below — Claude will read and categorise them.
          </div>
          <button className="aruto-banner-dismiss" onClick={() => setDismissedBanner(true)}>&times;</button>
        </div>
      )}

      {/* ===== WEEKLY OVERVIEW ===== */}
      <div className="week-overview">
        <div className="week-overview-chart">
          <ResponsiveContainer width="100%" height={80}>
            <BarChart data={data.weekly_trend} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <XAxis dataKey="week" tick={{ fill: '#8b8fa3', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: '0.8rem' }} formatter={(v) => [fmtMoney(v), 'Spent']} />
              {data.weekly_budget > 0 && <ReferenceLine y={data.weekly_budget} stroke="#00cec9" strokeDasharray="3 3" strokeWidth={1} />}
              <Bar dataKey="total" fill="#6c5ce7" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="week-overview-stats">
          <div className="week-stat"><span className="week-stat-label">This Week</span><span className="week-stat-value">{fmtMoney(thisWeek)}</span></div>
          <div className="week-stat"><span className="week-stat-label">Last Week</span><span className="week-stat-value" style={{ color: 'var(--text-muted)' }}>{fmtMoney(lastWeek)}</span></div>
          <div className="week-stat"><span className="week-stat-label">Change</span><span className="week-stat-value" style={{ color: weekChange <= 0 ? 'var(--green)' : 'var(--red)' }}>{weekChange > 0 ? '+' : ''}{weekChange}%</span></div>
          <div className="week-stat"><span className="week-stat-label">Budget/wk</span><span className="week-stat-value" style={{ color: 'var(--blue)' }}>{fmtMoney(data.weekly_budget)}</span></div>
        </div>
      </div>

      {/* ===== QUICK ADD ===== */}
      <div className="quick-add-card">
        <form onSubmit={handleQuickAdd} className="quick-add-form">
          <div className="quick-add-label"><Plus size={18} /><span>Quick Add</span></div>
          <select className="quick-add-select" value={category} onChange={e => setCategory(e.target.value)}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
          <div className="quick-add-amount"><span className="quick-add-dollar">$</span><input ref={amountRef} type="number" step="0.01" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} required /></div>
          <input className="quick-add-desc" type="text" placeholder="What for?" value={description} onChange={e => setDescription(e.target.value)} />
          <input className="quick-add-date" type="date" value={expenseDate} onChange={e => setExpenseDate(e.target.value)} />
          <button className="btn btn-primary quick-add-btn" type="submit" disabled={adding}>{adding ? '...' : 'Add'}</button>
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
          <Camera size={16} /><span>Import from Screenshot</span>
          <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleScreenshot} style={{ display: 'none' }} />
          <button className="btn btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()} disabled={extracting}>
            <Upload size={14} /> {extracting ? 'Reading...' : 'Upload'}
          </button>
        </div>
        {extracting && <div className="screenshot-extracting"><div className="spinner" /> Claude is reading your screenshot...</div>}
        {importResult && <div className="quick-add-confirm"><CheckCircle size={14} /> Imported {importResult.added} transaction{importResult.added !== 1 ? 's' : ''}{importResult.skipped > 0 && ` (${importResult.skipped} skipped)`}</div>}
        {extracted?.transactions?.length > 0 && (
          <div className="screenshot-review">
            <div className="screenshot-review-header"><span>{extracted.transactions.length} transactions found:</span></div>
            <div className="screenshot-txn-list">
              {extracted.transactions.map((t, i) => (
                <div key={i} className="screenshot-txn-row">
                  <input className="screenshot-txn-date" type="text" value={t.date} onChange={e => updateExtractedTxn(i, 'date', e.target.value)} />
                  <input className="screenshot-txn-desc" type="text" value={t.description} onChange={e => updateExtractedTxn(i, 'description', e.target.value)} />
                  <div className="screenshot-txn-amount"><span>$</span><input type="number" step="0.01" value={t.amount} onChange={e => updateExtractedTxn(i, 'amount', e.target.value)} /></div>
                  <select className="screenshot-txn-cat" value={t.category} onChange={e => updateExtractedTxn(i, 'category', e.target.value)}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
                  <button className="screenshot-txn-remove" onClick={() => removeExtractedTxn(i)}><X size={14} /></button>
                </div>
              ))}
            </div>
            <div className="screenshot-review-actions">
              <button className="btn btn-primary" onClick={handleImportExtracted} disabled={importing}>{importing ? 'Importing...' : `Import ${extracted.transactions.length} Transactions`}</button>
              <button className="btn btn-ghost" onClick={() => setExtracted(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* ===== PULSE + PACE ===== */}
      <div className="grid-2" style={{ marginBottom: '1rem' }}>
        <div className="card pulse-card">
          <div className="card-title"><Users size={14} /> Household Pulse</div>
          {insights?.user_activity?.map(u => {
            const isStale = u.days_since_last > 3;
            const isActive = u.days_since_last !== null && u.days_since_last <= 1;
            return (
              <div key={u.user_id} className="pulse-user clickable" onClick={() => navigate(`/expenses?user_id=${u.user_id}`)}>
                <div className="pulse-avatar" style={{ background: getUserColor(u.display_name) }}>{u.display_name[0]}</div>
                <div className="pulse-info">
                  <div className="pulse-name">{u.display_name}{isActive && <span className="pulse-badge pulse-badge-green">Active</span>}{isStale && <span className="pulse-badge pulse-badge-red">Needs logging</span>}</div>
                  <div className="pulse-stats">{u.month_count} entries ({fmtMoney(u.month_total)}){u.days_since_last !== null ? <span> · {u.days_since_last === 0 ? 'Today' : u.days_since_last === 1 ? 'Yesterday' : `${u.days_since_last}d ago`}</span> : <span> · No entries</span>}{u.streak > 2 && <span className="pulse-streak"> · {u.streak}d streak</span>}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="card">
          <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span><Zap size={14} /> Spending Pace</span>
            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 400 }}>{coreView ? 'Core only' : 'All spending'}</span>
          </div>
          {pace && (
            <>
              {(() => {
                const displayAvg = coreView ? (pace.core_daily_average || pace.daily_average) : pace.daily_average;
                const displayProjected = coreView ? (pace.core_projected_monthly || pace.projected_monthly) : pace.projected_monthly;
                const displayBudget = coreView ? (pace.core_monthly_budget || pace.monthly_budget) : pace.monthly_budget;
                const displayPct = displayBudget > 0 ? Math.round((displayProjected / displayBudget) * 100) : 0;
                return (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
                      <span style={{ fontSize: '1.5rem', fontWeight: 700, color: displayPct > 110 ? 'var(--red)' : displayPct > 90 ? 'var(--yellow)' : 'var(--green)' }}>{fmtMoney(displayAvg)}/day</span>
                      <div style={{ textAlign: 'right', fontSize: '0.8rem', color: 'var(--text-muted)' }}>Projected: {fmtMoney(displayProjected)}/mo<br />Budget: {fmtMoney(displayBudget)}/mo</div>
                    </div>
                    <div className="progress-bar" style={{ height: 12, marginBottom: '0.5rem' }}>
                      <div className={`progress-fill ${displayPct <= 90 ? 'green' : displayPct <= 110 ? 'yellow' : 'red'}`} style={{ width: `${Math.min(100, displayPct)}%` }} />
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                      <span>{fmtMoney(coreView ? (pace.core_total_spent || pace.total_spent) : pace.total_spent)} in {pace.days_elapsed}d</span>
                      <span style={{ fontWeight: 600, color: displayPct <= 100 ? 'var(--green)' : 'var(--red)' }}>{displayPct <= 100 ? `${100 - displayPct}% under` : `${displayPct - 100}% over`}</span>
                    </div>
                  </>
                );
              })()}
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
          <div className="card-sub">Budget: {fmtMoney(budgetedExpenses)} {data.monthly_expenses > 0 && (expenseDiff >= 0 ? <span style={{ color: 'var(--green)' }}>({fmtMoney(expenseDiff)} under)</span> : <span style={{ color: 'var(--red)' }}>({fmtMoney(Math.abs(expenseDiff))} over)</span>)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Mortgage</div>
          <div className="stat-value warning">{fmtMoney(data.mortgage_monthly)}</div>
          <div className="card-sub">Auto-debited from offset</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Monthly Surplus</div>
          <div className={`stat-value ${monthlySurplus >= 0 ? 'positive' : 'negative'}`}>{monthlySurplus >= 0 ? '+' : ''}{fmtMoney(monthlySurplus)}</div>
          <div className="card-sub">All surplus → offset</div>
        </div>
      </div>

      {/* ===== DAILY SPENDING ===== */}
      {(() => {
        const chartData = spendingData || insights?.daily_spending || [];
        const payEvents = chartData.filter(d => d.payday || d.mortgage_debit);
        const spendKey = coreView ? 'core_total' : 'total';

        // 7-day rolling average trend line
        const chartDataWithTrend = chartData.map((d, i) => {
          const windowStart = Math.max(0, i - 6);
          const slice = chartData.slice(windowStart, i + 1);
          const avg = slice.reduce((s, x) => s + (x[spendKey] || 0), 0) / slice.length;
          return { ...d, trend: Math.round(avg) };
        });

        // Use core or total daily budget for reference line
        const coreDailyBudget = data.core_budgeted_expenses ? data.core_budgeted_expenses / 30 : 0;
        const effectiveDailyBudget = coreView ? coreDailyBudget : dailyBudget;

        return (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div className="card-title" style={{ margin: 0 }}>Daily Spending</div>
                <div style={{ display: 'flex', gap: '2px', background: 'var(--bg)', borderRadius: 6, padding: 2 }}>
                  <button
                    className={`btn btn-sm ${coreView ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ padding: '2px 10px', fontSize: '0.72rem' }}
                    onClick={() => setCoreView(true)}
                    title="Core spending: excludes Insurance, Mortgage, Home"
                  >Core</button>
                  <button
                    className={`btn btn-sm ${!coreView ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ padding: '2px 10px', fontSize: '0.72rem' }}
                    onClick={() => setCoreView(false)}
                    title="All spending including Insurance, Mortgage, Home"
                  >All</button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {[{ label: '2W', days: 14 }, { label: '1M', days: 30 }, { label: '3M', days: 90 }, { label: '6M', days: 180 }, { label: '1Y', days: 365 }].map(r => (
                  <button key={r.days} className={`btn btn-sm ${spendingRange === r.days ? 'btn-primary' : 'btn-ghost'}`} style={{ padding: '2px 8px', fontSize: '0.7rem', minWidth: 32 }} onClick={() => setSpendingRange(r.days)}>{r.label}</button>
                ))}
              </div>
            </div>
            {coreView && (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                Excl. Insurance, Mortgage &amp; Home — <span style={{ color: 'var(--accent)' }}>shows day-to-day spending only</span>
              </div>
            )}
            {spendingLoading ? <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}><div className="spinner" /></div> : (
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={chartDataWithTrend}
                  onClick={(e) => { if (e?.activePayload?.[0]?.payload?.full_date) { navigate(`/expenses?start=${e.activePayload[0].payload.full_date}&end=${e.activePayload[0].payload.full_date}`); } }}
                  style={{ cursor: 'pointer' }}>
                  <defs>
                    <linearGradient id="spendGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6c5ce7" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="#6c5ce7" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fill: '#8b8fa3', fontSize: 10 }} interval={spendingRange > 60 ? Math.floor(spendingRange / 15) : spendingRange > 30 ? 2 : 0} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#8b8fa3', fontSize: 10 }} axisLine={false} tickLine={false} width={42} tickFormatter={v => v >= 1000 ? `$${(v/1000).toFixed(0)}k` : `$${v}`} />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      const spentVal = coreView ? d.core_total : d.total;
                      return (
                        <div className="payday-tooltip">
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.full_date}</div>
                          <div>{coreView ? 'Core spent' : 'Total spent'}: <strong>{fmtMoney(spentVal)}</strong></div>
                          {coreView && d.total !== d.core_total && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>All spending: {fmtMoney(d.total)}</div>
                          )}
                          <div style={{ fontSize: '0.75rem', color: '#fdcb6e' }}>7d avg: {fmtMoney(d.trend)}</div>
                          {d.payday && d.payday.map((p, i) => (
                            <div key={i} className="payday-tooltip-event">
                              <div className="payday-tooltip-title">{p.user_name}'s Pay</div>
                              <div>Net pay: {fmtMoney(p.net_pay)}</div>
                              <div style={{ color: '#00b894', fontWeight: 600 }}>+{fmtMoney(p.offset_transfer)} to offset</div>
                              {p.retention > 0 && <div style={{ color: '#fdcb6e' }}>Retained: {fmtMoney(p.retention)}</div>}
                              {p.goals?.length > 0 && p.goals.map((g, j) => (
                                <div key={j} style={{ color: '#6c5ce7', fontSize: '0.78rem' }}>{g.name}: +{fmtMoney(g.amount)}</div>
                              ))}
                            </div>
                          ))}
                          {d.mortgage_debit && (
                            <div className="payday-tooltip-event">
                              <div style={{ color: '#e17055', fontWeight: 600 }}>Mortgage: -{fmtMoney(d.mortgage_debit)}</div>
                            </div>
                          )}
                        </div>
                      );
                    }}
                  />
                  {effectiveDailyBudget > 0 && <ReferenceLine y={effectiveDailyBudget} stroke="#00cec9" strokeDasharray="4 3" strokeWidth={1.5} label={{ value: `${fmtMoney(effectiveDailyBudget)}/day`, fill: '#00cec9', fontSize: 10, position: 'right' }} />}
                  <Area type="monotone" dataKey={spendKey} stroke="#6c5ce7" fill="url(#spendGrad)" strokeWidth={2} activeDot={{ r: 5, stroke: '#6c5ce7', strokeWidth: 2, fill: 'var(--bg-card)' }} dot={false} />
                  <Line type="monotone" dataKey="trend" stroke="#fdcb6e" strokeWidth={2} dot={false} strokeDasharray="5 3" activeDot={false} />
                  {/* Payday vertical markers */}
                  {chartDataWithTrend.map((d, i) => d.payday ? (
                    <ReferenceLine key={`pay-${i}`} x={d.date} stroke="#00b894" strokeWidth={2} strokeDasharray="none"
                      label={{ value: `+${fmtK(d.total_offset_transfer)}`, fill: '#00b894', fontSize: 10, fontWeight: 700, position: 'top', offset: 5 }} />
                  ) : null)}
                  {/* Mortgage debit vertical markers */}
                  {chartDataWithTrend.map((d, i) => d.mortgage_debit ? (
                    <ReferenceLine key={`mtg-${i}`} x={d.date} stroke="#e17055" strokeWidth={1.5} strokeDasharray="6 3"
                      label={{ value: `-${fmtK(d.mortgage_debit)}`, fill: '#e17055', fontSize: 10, fontWeight: 600, position: 'insideTopRight' }} />
                  ) : null)}
                </ComposedChart>
              </ResponsiveContainer>
            )}
            <div style={{ display: 'flex', gap: '1rem', fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.25rem', paddingTop: '0.25rem', flexWrap: 'wrap' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 14, height: 2, background: '#6c5ce7', display: 'inline-block', borderRadius: 1 }} /> {coreView ? 'Core spend' : 'Total spend'}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 14, height: 2, background: '#fdcb6e', display: 'inline-block', borderRadius: 1, borderTop: '1px dashed #fdcb6e' }} /> 7-day avg</span>
              {effectiveDailyBudget > 0 && <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 14, height: 2, background: '#00cec9', display: 'inline-block', borderRadius: 1, opacity: 0.8 }} /> Budget</span>}
            </div>

            {/* Payday event legend below chart */}
            {payEvents.length > 0 && (
              <div className="payday-events-legend">
                {payEvents.map((d, i) => (
                  <div key={i} className="payday-event-pill">
                    {d.payday && d.payday.map((p, j) => (
                      <span key={j} className="payday-event-item payday-credit">
                        <span className="payday-event-dot" style={{ background: '#00b894' }} />
                        <span className="payday-event-date">{d.date}</span>
                        <strong>+{fmtMoney(p.offset_transfer)}</strong>
                        <span className="payday-event-user">{p.user_name}</span>
                        {p.goals?.length > 0 && (
                          <span className="payday-event-goals">
                            {p.goals.map((g, k) => (
                              <span key={k} className="payday-goal-chip">{g.name} +{fmtMoney(g.amount)}</span>
                            ))}
                          </span>
                        )}
                      </span>
                    ))}
                    {d.mortgage_debit && (
                      <span className="payday-event-item payday-debit">
                        <span className="payday-event-dot" style={{ background: '#e17055' }} />
                        <span className="payday-event-date">{d.date}</span>
                        <strong>-{fmtMoney(d.mortgage_debit)}</strong>
                        <span className="payday-event-user">Mortgage</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* ===== SPENDING ANALYSIS ===== */}
      {insights && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: '0.75rem' }}>
            <TrendingUp size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Spending Analysis
          </div>

          {/* Core vs All comparison */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
            {[
              {
                label: 'Core (30d)',
                hint: 'Excl. Insurance, Mortgage, Home',
                current: insights.core_monthly_spent || 0,
                previous: insights.prev_core_total || 0,
              },
              {
                label: 'Total (30d)',
                hint: 'All categories',
                current: pace?.total_spent || 0,
                previous: insights.prev_month_total || 0,
              },
            ].map(({ label, hint, current, previous }) => {
              const diff = current - previous;
              const diffPct = previous > 0 ? Math.round((diff / previous) * 100) : null;
              const isDown = diff < 0;
              return (
                <div key={label} style={{ background: 'var(--bg)', borderRadius: 8, padding: '0.6rem 0.75rem' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{fmtMoney(current)}</div>
                  <div style={{ fontSize: '0.72rem', marginTop: 2 }}>
                    {diffPct !== null ? (
                      <span style={{ color: isDown ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                        {isDown ? '↓' : '↑'}{Math.abs(diffPct)}% vs prev
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>vs {fmtMoney(previous)} prev</span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 1 }}>{hint}</div>
                </div>
              );
            })}
          </div>

          {/* Outlier spend breakdown */}
          {(() => {
            const outlierSpend = (pace?.total_spent || 0) - (insights.core_monthly_spent || 0);
            const outlierPct = pace?.total_spent > 0 ? Math.round((outlierSpend / pace.total_spent) * 100) : 0;
            const corePct = 100 - outlierPct;
            return outlierSpend > 0 ? (
              <div style={{ marginBottom: '0.75rem' }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.3rem', display: 'flex', justifyContent: 'space-between' }}>
                  <span>Spending composition</span>
                  <span>Outliers: <strong style={{ color: 'var(--text)' }}>{fmtMoney(outlierSpend)}</strong> ({outlierPct}%)</span>
                </div>
                <div style={{ height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--bg)', display: 'flex' }}>
                  <div style={{ width: `${corePct}%`, background: '#6c5ce7', transition: 'width 0.4s' }} title={`Core: ${corePct}%`} />
                  <div style={{ width: `${outlierPct}%`, background: '#e17055', transition: 'width 0.4s' }} title={`Outliers: ${outlierPct}%`} />
                </div>
                <div style={{ display: 'flex', gap: '1rem', fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                  <span><span style={{ color: '#6c5ce7' }}>■</span> Core {corePct}%</span>
                  <span><span style={{ color: '#e17055' }}>■</span> Insurance/Home {outlierPct}%</span>
                </div>
              </div>
            ) : null;
          })()}

          {/* Budget headroom */}
          {pace && (
            <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '0.6rem 0.75rem', marginBottom: '0.75rem' }}>
              {(() => {
                const today = new Date();
                const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
                const dayOfMonth = today.getDate();
                const daysLeft = daysInMonth - dayOfMonth;
                const coreBudget = data.core_budgeted_expenses || 0;
                const coreSpent = insights.core_monthly_spent || 0;
                // Scale budget to elapsed days in this rolling 30d window
                const scaledCoreBudget = coreBudget; // monthly budget
                const coreRemaining = scaledCoreBudget - coreSpent;
                const coreDailyLeft = daysLeft > 0 ? coreRemaining / daysLeft : 0;
                const onTrack = coreRemaining >= 0;
                return (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                      <span>Core budget headroom</span>
                      <span>{daysLeft}d left this month</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                      <span style={{ fontSize: '1.1rem', fontWeight: 700, color: onTrack ? 'var(--green)' : 'var(--red)' }}>
                        {onTrack ? '+' : ''}{fmtMoney(coreRemaining)}
                      </span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>remaining</span>
                      {daysLeft > 0 && (
                        <span style={{ fontSize: '0.75rem', color: onTrack ? 'var(--green)' : 'var(--red)', marginLeft: 'auto' }}>
                          {onTrack ? fmtMoney(Math.max(0, coreDailyLeft)) + '/day left' : 'over budget'}
                        </span>
                      )}
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {/* Category movers */}
          {insights.category_trends?.length > 0 && (
            <div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.4rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Category movers (vs prev 30d)
              </div>
              {insights.category_trends.slice(0, 5).map(t => {
                const isUp = t.change > 0;
                const hasChange = t.change !== 0 && t.previous > 0;
                return (
                  <div key={t.category}
                    className="clickable"
                    onClick={() => navigate(`/expenses?category=${encodeURIComponent(t.category)}`)}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.3rem 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: getCategoryColor(t.category), flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: '0.82rem' }}>{t.category}</span>
                    <span style={{ fontSize: '0.82rem', fontWeight: 600, minWidth: 60, textAlign: 'right' }}>{fmtMoney(t.current)}</span>
                    {hasChange ? (
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: isUp ? 'var(--red)' : 'var(--green)', minWidth: 52, textAlign: 'right' }}>
                        {isUp ? '↑' : '↓'}{Math.abs(t.change_pct)}%
                      </span>
                    ) : (
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', minWidth: 52, textAlign: 'right' }}>new</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ===== BY CATEGORY ===== */}
      <div className="card">
        <div className="card-title">By Category</div>
        {data.expenses_by_category.length > 0 ? (
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={data.expenses_by_category} dataKey="total" nameKey="category" cx="50%" cy="50%" outerRadius={90} innerRadius={40}
                label={({ category, total, percent }) => `${category} $${total.toFixed(0)} (${(percent * 100).toFixed(0)}%)`}
                labelLine={{ stroke: '#8b8fa3', strokeWidth: 0.5 }}
                onClick={(_, index) => { const cat = data.expenses_by_category[index]?.category; if (cat) navigate(`/expenses?category=${encodeURIComponent(cat)}`); }}
                style={{ cursor: 'pointer' }}>
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
                <div key={b.category} className="budget-bar-row clickable" onClick={() => navigate(`/expenses?category=${encodeURIComponent(b.category)}`)}>
                  <div className="budget-bar-label">
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: getCategoryColor(b.category), display: 'inline-block' }} />{b.category}</span>
                    <span><strong style={{ color: b.actual > b.budget ? 'var(--red)' : 'var(--text)' }}>{fmtMoney(b.actual)}</strong><span style={{ color: 'var(--text-muted)' }}> / {fmtMoney(b.budget)}</span></span>
                  </div>
                  <div className="progress-bar" style={{ height: 8, margin: '2px 0' }}>
                    <div className={`progress-fill ${pct <= 75 ? 'green' : pct <= 100 ? 'yellow' : 'red'}`} style={{ width: `${Math.min(100, pct)}%` }} />
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
          <div key={i} className="big-spend-row clickable" onClick={() => navigate(`/expenses?category=${encodeURIComponent(e.category)}`)}>
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
        <div className="card card-animate" onClick={() => navigate('/goals')} style={{ cursor: 'pointer' }}>
          <div className="card-title"><Target size={14} /> Offset Goals</div>
          {data.goals.map((g, i) => {
            const pct = g.target_amount > 0 ? Math.min(100, (g.current_amount / g.target_amount) * 100) : 0;
            const isMilestone = pct >= 100;
            return (
              <div key={g.id} style={{ marginBottom: '0.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: bucketColors[i % bucketColors.length], display: 'inline-block' }} />
                    <span style={{ fontWeight: 600 }}>{g.name}</span>
                    {g.weekly_change !== null && g.weekly_change > 0 && (
                      <span className="goal-change-badge positive" style={{ fontSize: '0.7rem' }}>+{fmtK(g.weekly_change)}</span>
                    )}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {fmtMoney(g.current_amount)} / {fmtMoney(g.target_amount)}
                    <span style={{ fontWeight: 600, color: isMilestone ? 'var(--green)' : 'inherit', marginLeft: 4 }}>({pct.toFixed(0)}%){isMilestone && ' \u2713'}</span>
                  </span>
                </div>
                <div className={`progress-bar${isMilestone ? ' milestone-pulse' : ''}`}>
                  <div className="progress-fill progress-fill-animate" style={{ width: `${pct}%`, background: bucketColors[i % bucketColors.length] }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
