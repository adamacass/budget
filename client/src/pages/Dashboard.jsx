import React, { useState, useEffect } from 'react';
import { getDashboard, getLatestAdvice } from '../api';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

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
          <div className="card-sub">Combined take-home</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Monthly Expenses</div>
          <div className="stat-value negative">{fmtMoney(data.monthly_expenses)}</div>
          <div className="card-sub">Last 30 days</div>
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
                formatter={(v) => ['$' + v.toFixed(0), 'Spent']}
              />
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
