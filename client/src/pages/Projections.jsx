import React, { useState, useEffect } from 'react';
import { getProjections, getExpenses } from '../api';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, BarChart, Bar, ReferenceLine } from 'recharts';
import { TrendingUp, TrendingDown, AlertTriangle, Award, DollarSign, Target } from 'lucide-react';

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function fmtK(n) { return n >= 1000 ? '$' + (n / 1000).toFixed(0) + 'k' : fmtMoney(n); }

export default function Projections() {
  const [data, setData] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getProjections(),
      getExpenses({ start: new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0] })
    ]).then(([p, e]) => { setData(p); setExpenses(e); }).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading-page"><div className="spinner" /> Loading projections...</div>;
  if (!data) return <div>Failed to load projections</div>;

  // Benchmark comparison
  const benchmarks = data.benchmarks || {};
  const categoryTotals = {};
  expenses.forEach(e => { categoryTotals[e.category] = (categoryTotals[e.category] || 0) + e.amount; });

  const benchmarkComparison = Object.entries(benchmarks).map(([key, b]) => {
    const catName = b.label.replace(' & Fitness', '');
    const actual = categoryTotals[catName] || categoryTotals[b.label] || 0;
    return { category: b.label, actual: Math.round(actual), low: b.low, mid: b.mid, high: b.high };
  }).filter(b => b.actual > 0);

  const statusIcon = data.status === 'great' ? <TrendingUp size={18} /> : data.status === 'okay' ? <Award size={18} /> : <AlertTriangle size={18} />;
  const statusColor = data.status === 'great' ? 'var(--green)' : data.status === 'okay' ? 'var(--yellow)' : 'var(--red)';

  return (
    <div>
      <div className="page-header">
        <h2>Projections</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>12-month offset growth forecast</p>
      </div>

      {/* Status banner */}
      <div className="card" style={{ borderLeft: `4px solid ${statusColor}`, marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ color: statusColor }}>{statusIcon}</div>
          <div style={{ fontSize: '0.95rem' }}>{data.message}</div>
        </div>
      </div>

      {/* Key numbers */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Net Income</div>
          <div className="stat-value positive">{fmtMoney(data.monthly_net_income)}/mo</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Expenses</div>
          <div className="stat-value negative">{fmtMoney(data.monthly_expenses)}/mo</div>
          <div className="card-sub">Budget: {fmtMoney(data.budgeted_expenses)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Surplus to Offset</div>
          <div className={`stat-value ${data.monthly_surplus >= 0 ? 'positive' : 'negative'}`}>
            {data.monthly_surplus >= 0 ? '+' : ''}{fmtMoney(data.monthly_surplus)}/mo
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Net Offset Growth</div>
          <div className={`stat-value ${data.net_offset_growth >= 0 ? 'positive' : 'negative'}`}>
            {data.net_offset_growth >= 0 ? '+' : ''}{fmtMoney(data.net_offset_growth)}/mo
          </div>
          <div className="card-sub">After ${fmtMoney(data.mortgage)} mortgage</div>
        </div>
      </div>

      {/* 12-month offset projection */}
      <div className="card">
        <div className="card-title"><DollarSign size={14} /> 12-Month Offset Projection</div>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
          Current: {fmtMoney(data.offset_balance)} — Projected in 12 months: {fmtMoney(data.projections?.[11]?.offset || 0)}
        </p>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data.projections}>
            <XAxis dataKey="month" tick={{ fill: '#8b8fa3', fontSize: 11 }} />
            <YAxis tick={{ fill: '#8b8fa3', fontSize: 11 }} tickFormatter={v => fmtK(v)} />
            <Tooltip
              contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}
              formatter={(v, name) => [fmtMoney(v), name]}
            />
            <Legend />
            <Line type="monotone" dataKey="offset" stroke="#6c5ce7" strokeWidth={3} name="Offset Balance" dot={{ r: 4 }} />
            <Line type="monotone" dataKey="interest_saved" stroke="#00cec9" strokeWidth={2} name="Interest Saved/mo" strokeDasharray="4 3" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Monthly flow breakdown */}
      <div className="card">
        <div className="card-title">Monthly Offset Flow</div>
        <div className="retention-breakdown">
          <div className="retention-row">
            <span>Surplus (income − expenses)</span>
            <span style={{ color: 'var(--green)' }}>+{fmtMoney(Math.max(0, data.budgeted_surplus || data.monthly_surplus))}</span>
          </div>
          <div className="retention-row">
            <span>Mortgage auto-debit (23rd)</span>
            <span style={{ color: 'var(--red)' }}>−{fmtMoney(data.mortgage)}</span>
          </div>
          <div className="retention-row total">
            <span>Net offset growth/month</span>
            <span style={{ color: data.net_offset_growth >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {data.net_offset_growth >= 0 ? '+' : ''}{fmtMoney(data.net_offset_growth)}
            </span>
          </div>
        </div>
      </div>

      {/* Goal achievement */}
      {data.goals?.length > 0 && (
        <div className="card">
          <div className="card-title"><Target size={14} /> Goal Achievement Forecast</div>
          {data.goals.map(g => {
            const pct = g.target_amount > 0 ? (g.current_amount / g.target_amount * 100) : 0;
            return (
              <div key={g.id} style={{ marginBottom: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: 4 }}>
                  <span style={{ fontWeight: 600 }}>{g.name}</span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {fmtMoney(g.current_amount)} / {fmtMoney(g.target_amount)}
                    {g.months_to_goal && g.months_to_goal <= 24 && <span style={{ marginLeft: 8, color: 'var(--accent)' }}>~{g.months_to_goal}mo to go</span>}
                  </span>
                </div>
                <div className="progress-bar" style={{ height: 10 }}>
                  <div className={`progress-fill ${pct >= 75 ? 'green' : pct >= 40 ? 'yellow' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Benchmarks */}
      {benchmarkComparison.length > 0 && (
        <div className="card">
          <div className="card-title">Sydney Household Benchmarks</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Category</th><th>Your Spend</th><th>Low</th><th>Mid</th><th>High</th><th>Status</th></tr>
              </thead>
              <tbody>
                {benchmarkComparison.map(b => {
                  const status = b.actual <= b.low ? 'green' : b.actual <= b.mid ? 'yellow' : 'red';
                  return (
                    <tr key={b.category}>
                      <td style={{ fontWeight: 600 }}>{b.category}</td>
                      <td style={{ fontWeight: 600, color: status === 'red' ? 'var(--red)' : status === 'green' ? 'var(--green)' : 'var(--yellow)' }}>{fmtMoney(b.actual)}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{fmtMoney(b.low)}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{fmtMoney(b.mid)}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{fmtMoney(b.high)}</td>
                      <td><span className={`tag tag-${status === 'green' ? 'green' : status === 'yellow' ? 'yellow' : 'red'}`}>{status === 'green' ? 'Below avg' : status === 'yellow' ? 'Average' : 'Above avg'}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Benchmarks chart */}
      {benchmarkComparison.length > 0 && (
        <div className="card">
          <div className="card-title">Spending vs Benchmarks</div>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={benchmarkComparison} layout="vertical">
              <XAxis type="number" tick={{ fill: '#8b8fa3', fontSize: 11 }} />
              <YAxis type="category" dataKey="category" tick={{ fill: '#8b8fa3', fontSize: 11 }} width={100} />
              <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }} formatter={(v) => fmtMoney(v)} />
              <Legend />
              <Bar dataKey="actual" fill="#6c5ce7" name="Your Spend" radius={[0, 3, 3, 0]} />
              <Bar dataKey="mid" fill="rgba(0,206,201,0.3)" name="Sydney Mid" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
