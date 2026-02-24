import React, { useState, useEffect } from 'react';
import { getDashboard, getLatestAdvice } from '../api';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, ReferenceLine } from 'recharts';

const COLORS = ['#6c5ce7', '#00cec9', '#ff6b6b', '#feca57', '#54a0ff', '#a29bfe', '#fd79a8', '#55efc4', '#fab1a0', '#74b9ff'];

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [advice, setAdvice] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getDashboard(), getLatestAdvice('nightly')])
      .then(([d, a]) => { setData(d); setAdvice(a); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading-page"><div className="spinner" /> Loading dashboard...</div>;
  if (!data) return <div>Failed to load dashboard</div>;

  const netSavings = data.monthly_income - data.monthly_expenses - data.mortgage_monthly;
  const totalAssets = (data.balances.offset || 0) + (data.balances.savings || 0) + (data.balances.investment || 0);

  // Budget comparison
  const estimatedIncome = data.estimated_monthly_income || 0;
  const budgetedExpenses = data.budgeted_expenses || 0;
  const budgetedNet = estimatedIncome - budgetedExpenses - data.mortgage_monthly;
  const expenseDiff = budgetedExpenses - data.monthly_expenses;

  // Budget vs actual by category
  const budgetComparison = (data.budget_by_category || []).map(b => {
    const expRow = data.expenses_by_category.find(e => e.category === b.category);
    return {
      category: b.category,
      budget: b.budget,
      actual: expRow ? expRow.total : 0,
      remaining: b.budget - (expRow ? expRow.total : 0)
    };
  }).sort((a, b) => b.budget - a.budget);

  const totalBudget = budgetComparison.reduce((s, b) => s + b.budget, 0);
  const totalActual = budgetComparison.reduce((s, b) => s + b.actual, 0);

  return (
    <div>
      <div className="page-header">
        <h2>Dashboard</h2>
        <p>Your household financial overview</p>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Monthly Income (Net)</div>
          <div className={`stat-value ${data.monthly_income > 0 ? 'positive' : 'neutral'}`}>
            {fmtMoney(data.monthly_income)}
          </div>
          <div className="card-sub">
            {estimatedIncome > 0 ? `Expected: ${fmtMoney(estimatedIncome)}` : 'Combined take-home'}
          </div>
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
          <div className="card-sub">
            {budgetedNet > 0 ? `Budgeted: +${fmtMoney(budgetedNet)}` : (netSavings >= 0 ? 'Surplus this month' : 'Deficit this month')}
          </div>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Offset Account</div>
          <div className="stat-value positive">{fmtMoney(data.balances.offset)}</div>
          <div className="card-sub">Reducing mortgage interest</div>
        </div>
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
          <div className="card-sub">Crypto / Stocks</div>
        </div>
      </div>

      {/* Savings Goals Progress */}
      {data.goals && data.goals.length > 0 && (
        <div className="card">
          <div className="card-title">Savings Goals Progress</div>
          {data.goals.map(g => {
            const pct = g.target_amount > 0 ? Math.min(100, (g.current_amount / g.target_amount) * 100) : 0;
            return (
              <div key={g.id} style={{ marginBottom: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
                  <span style={{ fontWeight: 600 }}>{g.name}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{fmtMoney(g.current_amount)} / {fmtMoney(g.target_amount)}</span>
                </div>
                <div className="progress-bar">
                  <div
                    className={`progress-fill ${pct >= 75 ? 'green' : pct >= 40 ? 'yellow' : ''}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="grid-2">
        {/* Weekly Spending Trend */}
        <div className="card">
          <div className="card-title">Weekly Spending Trend</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.weekly_trend}>
              <XAxis dataKey="week" tick={{ fill: '#8b8fa3', fontSize: 12 }} />
              <YAxis tick={{ fill: '#8b8fa3', fontSize: 12 }} />
              <Tooltip
                contentStyle={{ background: '#1a1d27', border: '1px solid #2d3148', borderRadius: 8 }}
                labelStyle={{ color: '#e8eaf0' }}
                formatter={(v, name) => ['$' + v.toFixed(0), name === 'total' ? 'Spent' : 'Budget']}
              />
              {data.weekly_budget > 0 && (
                <ReferenceLine
                  y={data.weekly_budget}
                  stroke="#00cec9"
                  strokeDasharray="5 5"
                  strokeWidth={2}
                  label={{ value: `Budget $${data.weekly_budget}`, position: 'right', fill: '#00cec9', fontSize: 10 }}
                />
              )}
              <Bar dataKey="total" fill="#6c5ce7" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Spending by Category */}
        <div className="card">
          <div className="card-title">Spending by Category</div>
          {data.expenses_by_category.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={data.expenses_by_category}
                  dataKey="total"
                  nameKey="category"
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  label={({ category, total }) => `${category}: $${total.toFixed(0)}`}
                >
                  {data.expenses_by_category.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => '$' + v.toFixed(0)} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No expenses recorded yet. Start tracking in the Expenses tab.</p>
          )}
        </div>
      </div>

      {/* Budget Tracker */}
      {budgetComparison.length > 0 && (
        <div className="card">
          <div className="card-title">Budget Tracker</div>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Conservative monthly budget vs actual spending (last 30 days). Adjust overall budget via the "Budget Scale %" lever in Goals & Levers.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Budget</th>
                  <th>Actual</th>
                  <th>Remaining</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {budgetComparison.map(b => {
                  const pct = b.budget > 0 ? (b.actual / b.budget) * 100 : 0;
                  return (
                    <tr key={b.category}>
                      <td style={{ fontWeight: 600 }}>{b.category}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{fmtMoney(b.budget)}</td>
                      <td style={{ fontWeight: 600 }}>{fmtMoney(b.actual)}</td>
                      <td style={{ color: b.remaining >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                        {b.remaining >= 0 ? fmtMoney(b.remaining) : '-' + fmtMoney(Math.abs(b.remaining))}
                      </td>
                      <td>
                        {b.actual === 0 ? <span className="tag tag-blue">No spend</span> :
                         pct <= 75 ? <span className="tag tag-green">On track</span> :
                         pct <= 100 ? <span className="tag tag-yellow">Watch</span> :
                         <span className="tag tag-red">Over</span>}
                      </td>
                    </tr>
                  );
                })}
                <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
                  <td>Total</td>
                  <td style={{ color: 'var(--text-muted)' }}>{fmtMoney(totalBudget)}</td>
                  <td>{fmtMoney(totalActual)}</td>
                  <td style={{ color: totalBudget - totalActual >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {totalBudget - totalActual >= 0 ? fmtMoney(totalBudget - totalActual) : '-' + fmtMoney(Math.abs(totalBudget - totalActual))}
                  </td>
                  <td>
                    {totalActual <= totalBudget
                      ? <span className="tag tag-green">{fmtMoney(totalBudget - totalActual)} left</span>
                      : <span className="tag tag-red">{fmtMoney(totalActual - totalBudget)} over</span>}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Claude Advice */}
      {advice && advice.content && (
        <div className="advice-box">
          <h3>Claude's Latest Summary</h3>
          {advice.content}
        </div>
      )}

      {/* Total net worth */}
      <div className="card" style={{ textAlign: 'center' }}>
        <div className="card-title">Total Tracked Assets</div>
        <div className="card-value" style={{ color: 'var(--green)' }}>{fmtMoney(totalAssets)}</div>
        <div className="card-sub">Offset + Savings + Investments (excl. property equity)</div>
      </div>
    </div>
  );
}
