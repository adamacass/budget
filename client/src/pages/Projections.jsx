import React, { useState, useEffect } from 'react';
import { getProjections, getExpenses } from '../api';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, BarChart, Bar } from 'recharts';
import { TrendingUp, TrendingDown, AlertTriangle, Award } from 'lucide-react';

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }

export default function Projections() {
  const [data, setData] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    Promise.all([getProjections(), getExpenses({ start: thirtyDaysAgo })])
      .then(([p, e]) => { setData(p); setExpenses(e); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading-page"><div className="spinner" /></div>;
  if (!data) return <div>Failed to load projections</div>;

  // Compare spending vs benchmarks
  const expensesByCategory = {};
  expenses.forEach(e => {
    const cat = e.category.toLowerCase().replace(/\s+/g, '_');
    if (!expensesByCategory[cat]) expensesByCategory[cat] = 0;
    expensesByCategory[cat] += e.amount;
  });

  const benchmarkComparison = Object.entries(data.benchmarks).map(([key, bench]) => {
    const actual = expensesByCategory[key] || 0;
    const midPoint = (bench.low + bench.high) / 2;
    const status = actual === 0 ? 'none' : actual <= bench.low ? 'great' : actual <= midPoint ? 'good' : actual <= bench.high ? 'watch' : 'over';
    return { key, label: bench.label, actual, low: bench.low, mid: midPoint, high: bench.high, status };
  });

  const budgetedExpenses = data.budgeted_expenses || 0;
  const budgetedSurplus = data.budgeted_surplus || 0;
  const expenseDiff = budgetedExpenses - data.monthly_expenses;

  return (
    <div>
      <div className="page-header">
        <h2>Projections & Analysis</h2>
        <p>12-month forecast based on your budget plan</p>
      </div>

      {/* Status banner */}
      <div className="card" style={{
        borderLeft: `4px solid ${data.status === 'great' ? 'var(--green)' : data.status === 'okay' ? 'var(--yellow)' : 'var(--red)'}`,
        display: 'flex', alignItems: 'center', gap: '1rem'
      }}>
        {data.status === 'great' ? <Award size={24} color="var(--green)" /> :
         data.status === 'okay' ? <TrendingUp size={24} color="var(--yellow)" /> :
         <AlertTriangle size={24} color="var(--red)" />}
        <div>
          <div style={{ fontWeight: 700, fontSize: '1rem' }}>{data.message}</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            Net income: {fmtMoney(data.monthly_net_income)} | Budget: {fmtMoney(budgetedExpenses)} | Actual: {fmtMoney(data.monthly_expenses)} | Mortgage: {fmtMoney(data.mortgage)}
          </div>
        </div>
      </div>

      {/* Key numbers */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Combined Monthly Net Income</div>
          <div className="stat-value positive">{fmtMoney(data.monthly_net_income)}</div>
          <div className="card-sub">After tax, super, HECS</div>
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
          <div className="stat-label">Monthly Surplus</div>
          <div className={`stat-value ${data.monthly_surplus >= 0 ? 'positive' : 'negative'}`}>
            {data.monthly_surplus >= 0 ? '+' : ''}{fmtMoney(data.monthly_surplus)}
          </div>
          <div className="card-sub">
            Budgeted: {budgetedSurplus >= 0 ? '+' : ''}{fmtMoney(budgetedSurplus)}
          </div>
        </div>
      </div>

      {/* 12 Month Projection */}
      <div className="card">
        <div className="card-title">12-Month Net Worth Projection</div>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
          Based on sticking to the {fmtMoney(budgetedExpenses)}/mo budget with {fmtMoney(budgetedSurplus)}/mo surplus
        </p>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data.projections}>
            <XAxis dataKey="month" tick={{ fill: '#8b8fa3', fontSize: 12 }} />
            <YAxis tick={{ fill: '#8b8fa3', fontSize: 12 }} tickFormatter={v => '$' + (v / 1000).toFixed(0) + 'k'} />
            <Tooltip
              contentStyle={{ background: '#1a1d27', border: '1px solid #2d3148', borderRadius: 8 }}
              formatter={(v) => [fmtMoney(v)]}
            />
            <Legend />
            <Line type="monotone" dataKey="offset" stroke="#00cec9" name="Offset" strokeWidth={2} />
            <Line type="monotone" dataKey="savings" stroke="#6c5ce7" name="Savings" strokeWidth={2} />
            <Line type="monotone" dataKey="investment" stroke="#feca57" name="Investment" strokeWidth={2} />
            <Line type="monotone" dataKey="total_net_worth" stroke="#54a0ff" name="Total" strokeWidth={3} strokeDasharray="5 5" />
          </LineChart>
        </ResponsiveContainer>
        {data.projections.length > 0 && (
          <div style={{ textAlign: 'center', marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Projected total in 12 months: <strong style={{ color: 'var(--green)' }}>{fmtMoney(data.projections[data.projections.length - 1].total_net_worth)}</strong>
          </div>
        )}
      </div>

      {/* Goals Progress */}
      {data.goals.length > 0 && (
        <div className="card">
          <div className="card-title">Goal Achievement Forecast</div>
          {data.goals.map(g => {
            const pct = g.target_amount > 0 ? (g.current_amount / g.target_amount) * 100 : 0;
            const monthlyRate = budgetedSurplus > 0 ? budgetedSurplus * 0.3 : 0;
            const remaining = g.target_amount - g.current_amount;
            const monthsToGoal = monthlyRate > 0 ? Math.ceil(remaining / monthlyRate) : null;
            return (
              <div key={g.id} style={{ marginBottom: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{g.name}</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    {pct.toFixed(1)}% | {monthsToGoal ? `~${monthsToGoal} months to go` : 'No surplus to project'}
                    {g.target_date && ` | Target: ${g.target_date}`}
                  </span>
                </div>
                <div className="progress-bar">
                  <div className={`progress-fill ${pct >= 75 ? 'green' : pct >= 40 ? 'yellow' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Benchmark Comparison */}
      <div className="card">
        <div className="card-title">Sydney Spending Benchmarks (Monthly, Mid-High Range)</div>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
          Your spending vs typical Sydney household (mid-high range). Green = below mid, Yellow = between mid and high, Red = above high.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Your Spend</th>
                <th>Low</th>
                <th>Mid</th>
                <th>High</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {benchmarkComparison.map(b => (
                <tr key={b.key}>
                  <td style={{ fontWeight: 600 }}>{b.label}</td>
                  <td style={{ fontWeight: 600 }}>{fmtMoney(b.actual)}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{fmtMoney(b.low)}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{fmtMoney(b.mid)}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{fmtMoney(b.high)}</td>
                  <td>
                    {b.status === 'none' ? <span className="tag tag-blue">No data</span> :
                     b.status === 'great' ? <span className="tag tag-green">Excellent</span> :
                     b.status === 'good' ? <span className="tag tag-green">Good</span> :
                     b.status === 'watch' ? <span className="tag tag-yellow">Watch</span> :
                     <span className="tag tag-red">Over budget</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Spending vs Benchmark Chart */}
      <div className="card">
        <div className="card-title">Spending vs Benchmark (Visual)</div>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={benchmarkComparison.filter(b => b.actual > 0)}>
            <XAxis dataKey="label" tick={{ fill: '#8b8fa3', fontSize: 11 }} angle={-30} textAnchor="end" height={60} />
            <YAxis tick={{ fill: '#8b8fa3', fontSize: 12 }} />
            <Tooltip
              contentStyle={{ background: '#1a1d27', border: '1px solid #2d3148', borderRadius: 8 }}
              formatter={(v) => [fmtMoney(v)]}
            />
            <Legend />
            <Bar dataKey="actual" fill="#6c5ce7" name="Your Spend" radius={[4, 4, 0, 0]} />
            <Bar dataKey="mid" fill="#2d3148" name="Sydney Mid" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
