import React, { useState, useEffect, useRef } from 'react';
import { getDashboard, getInsights, getLatestAdvice, addExpense } from '../api';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, ReferenceLine, AreaChart, Area } from 'recharts';
import { Plus, Zap, TrendingUp, Users, DollarSign, AlertTriangle, CheckCircle, Clock, ArrowUpRight } from 'lucide-react';

const COLORS = ['#6c5ce7', '#00cec9', '#ff6b6b', '#feca57', '#54a0ff', '#a29bfe', '#fd79a8', '#55efc4', '#fab1a0', '#74b9ff'];
const CATEGORIES = [
  'Groceries', 'Dining Out', 'Transport', 'Utilities', 'Insurance',
  'Entertainment', 'Health', 'Clothing', 'Personal Care', 'Subscriptions',
  'Pets', 'Gifts', 'Education', 'Home', 'Mortgage', 'Other'
];

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function fmtMoney2(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [insights, setInsights] = useState(null);
  const [advice, setAdvice] = useState(null);
  const [loading, setLoading] = useState(true);

  // Quick add form
  const [category, setCategory] = useState('Groceries');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().split('T')[0]);
  const [adding, setAdding] = useState(false);
  const [addedMsg, setAddedMsg] = useState('');
  const amountRef = useRef(null);

  function loadAll() {
    Promise.all([getDashboard(), getInsights(), getLatestAdvice('nightly')])
      .then(([d, i, a]) => { setData(d); setInsights(i); setAdvice(a); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadAll(); }, []);

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
      // Reload data
      Promise.all([getDashboard(), getInsights()])
        .then(([d, i]) => { setData(d); setInsights(i); });
      amountRef.current?.focus();
    } catch (err) { alert(err.message); }
    setAdding(false);
  }

  if (loading) return <div className="loading-page"><div className="spinner" /> Loading dashboard...</div>;
  if (!data) return <div>Failed to load dashboard</div>;

  const netSavings = data.monthly_income - data.monthly_expenses - data.mortgage_monthly;
  const totalAssets = (data.balances.offset || 0) + (data.balances.savings || 0) + (data.balances.investment || 0);
  const estimatedIncome = data.estimated_monthly_income || 0;
  const budgetedExpenses = data.budgeted_expenses || 0;
  const expenseDiff = budgetedExpenses - data.monthly_expenses;

  // Budget comparison
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

  return (
    <div>
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
                {e.category} <strong>{fmtMoney2(e.amount)}</strong>
                <span className="recent-who">{e.user_name}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ===== HOUSEHOLD PULSE + SPENDING PACE ===== */}
      <div className="grid-2" style={{ marginBottom: '1rem' }}>
        {/* Household Pulse */}
        <div className="card pulse-card">
          <div className="card-title"><Users size={14} /> Household Pulse</div>
          {insights?.user_activity?.map(u => {
            const isStale = u.days_since_last > 3;
            const isActive = u.days_since_last !== null && u.days_since_last <= 1;
            return (
              <div key={u.user_id} className="pulse-user">
                <div className="pulse-avatar">{u.display_name[0]}</div>
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

        {/* Spending Pace */}
        <div className="card">
          <div className="card-title"><Zap size={14} /> Spending Pace</div>
          {pace && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
                <div>
                  <span style={{ fontSize: '1.5rem', fontWeight: 700, color: pacePercent > 110 ? 'var(--red)' : pacePercent > 90 ? 'var(--yellow)' : 'var(--green)' }}>
                    {fmtMoney(pace.daily_average)}/day
                  </span>
                </div>
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
                  {pacePercent <= 100
                    ? `${100 - pacePercent}% under budget`
                    : `${pacePercent - 100}% over budget`}
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
          <div className={`stat-value ${data.monthly_income > 0 ? 'positive' : 'neutral'}`}>
            {fmtMoney(data.monthly_income)}
          </div>
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
          <div className="card-sub">Monthly repayment</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Net Position</div>
          <div className={`stat-value ${netSavings >= 0 ? 'positive' : 'negative'}`}>
            {netSavings >= 0 ? '+' : ''}{fmtMoney(netSavings)}
          </div>
          <div className="card-sub">{netSavings >= 0 ? 'Surplus this month' : 'Deficit this month'}</div>
        </div>
      </div>

      {/* ===== OFFSET ACCOUNT INSIGHTS ===== */}
      {offsetIns && (
        <div className="card offset-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
            <div>
              <div className="card-title" style={{ marginBottom: '0.25rem' }}><DollarSign size={14} /> Offset Account</div>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--green)' }}>{fmtMoney(offsetIns.balance)}</div>
            </div>
            <div className="offset-stats">
              <div className="offset-stat">
                <span className="offset-stat-label">Interest Saved/mo</span>
                <span className="offset-stat-value">{fmtMoney(offsetIns.monthly_interest_saved)}</span>
              </div>
              <div className="offset-stat">
                <span className="offset-stat-label">Interest Saved/yr</span>
                <span className="offset-stat-value">{fmtMoney(offsetIns.annual_interest_saved)}</span>
              </div>
              <div className="offset-stat">
                <span className="offset-stat-label">Mortgage Rate</span>
                <span className="offset-stat-value">{(offsetIns.mortgage_rate * 100).toFixed(1)}%</span>
              </div>
            </div>
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
            <ArrowUpRight size={12} style={{ verticalAlign: 'middle' }} /> Every $10,000 extra in offset saves ~{fmtMoney(Math.round(10000 * offsetIns.mortgage_rate))}/year in interest
          </div>
        </div>
      )}

      {/* ===== DAILY SPENDING + CATEGORY BREAKDOWN ===== */}
      <div className="grid-2">
        <div className="card">
          <div className="card-title">Daily Spending (14 days)</div>
          {insights?.daily_spending && (
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={insights.daily_spending}>
                <XAxis dataKey="date" tick={{ fill: '#8b8fa3', fontSize: 11 }} />
                <YAxis tick={{ fill: '#8b8fa3', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: '#1a1d27', border: '1px solid #2d3148', borderRadius: 8 }}
                  formatter={(v) => [fmtMoney(v), 'Spent']}
                />
                <Area type="monotone" dataKey="total" stroke="#6c5ce7" fill="rgba(108,92,231,0.2)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card">
          <div className="card-title">Spending by Category</div>
          {data.expenses_by_category.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={data.expenses_by_category} dataKey="total" nameKey="category"
                  cx="50%" cy="50%" outerRadius={70}
                  label={({ category, total }) => `${category}: $${total.toFixed(0)}`}>
                  {data.expenses_by_category.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => '$' + v.toFixed(0)} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No expenses recorded yet.</p>
          )}
        </div>
      </div>

      {/* ===== BUDGET TRACKER WITH PROGRESS BARS ===== */}
      {budgetComparison.length > 0 && (
        <div className="card">
          <div className="card-title">Budget Tracker</div>
          <div className="budget-bars">
            {budgetComparison.map(b => {
              const pct = b.budget > 0 ? (b.actual / b.budget) * 100 : 0;
              const over = b.actual > b.budget;
              return (
                <div key={b.category} className="budget-bar-row">
                  <div className="budget-bar-label">
                    <span>{b.category}</span>
                    <span>
                      <strong style={{ color: over ? 'var(--red)' : 'var(--text)' }}>{fmtMoney(b.actual)}</strong>
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

      {/* ===== BIGGEST SPENDS + WEEKLY TREND ===== */}
      <div className="grid-2">
        <div className="card">
          <div className="card-title">Biggest Spends (30 days)</div>
          {insights?.biggest_expenses?.map((e, i) => (
            <div key={i} className="big-spend-row">
              <div className="big-spend-rank">#{i + 1}</div>
              <div className="big-spend-info">
                <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{e.description || e.category}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {e.category} · {e.expense_date} · {e.user_name}
                </div>
              </div>
              <div className="big-spend-amount">{fmtMoney(e.amount)}</div>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-title">Weekly Spending Trend</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data.weekly_trend}>
              <XAxis dataKey="week" tick={{ fill: '#8b8fa3', fontSize: 12 }} />
              <YAxis tick={{ fill: '#8b8fa3', fontSize: 12 }} />
              <Tooltip
                contentStyle={{ background: '#1a1d27', border: '1px solid #2d3148', borderRadius: 8 }}
                formatter={(v) => ['$' + v.toFixed(0), 'Spent']}
              />
              {data.weekly_budget > 0 && (
                <ReferenceLine y={data.weekly_budget} stroke="#00cec9" strokeDasharray="5 5" strokeWidth={2}
                  label={{ value: `Budget $${data.weekly_budget}`, position: 'right', fill: '#00cec9', fontSize: 10 }} />
              )}
              <Bar dataKey="total" fill="#6c5ce7" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ===== SAVINGS GOALS ===== */}
      {data.goals && data.goals.length > 0 && (
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
                  <div className={`progress-fill ${pct >= 75 ? 'green' : pct >= 40 ? 'yellow' : ''}`}
                    style={{ width: `${pct}%` }} />
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
          <div className={`stat-value ${data.balances.credit_card > 0 ? 'negative' : 'positive'}`}>
            {fmtMoney(data.balances.credit_card)}
          </div>
          <div className="card-sub">{data.balances.credit_card > 0 ? 'Outstanding' : 'Clear'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Investments</div>
          <div className="stat-value neutral">{fmtMoney(data.balances.investment)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total Assets</div>
          <div className="stat-value positive">{fmtMoney(totalAssets)}</div>
          <div className="card-sub">Offset + Savings + Investments</div>
        </div>
      </div>

      {/* Claude Advice */}
      {advice && advice.content && (
        <div className="advice-box">
          <h3>Claude's Latest Summary</h3>
          {advice.content}
        </div>
      )}
    </div>
  );
}
