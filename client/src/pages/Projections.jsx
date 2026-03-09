import React, { useState, useEffect, useCallback } from 'react';
import { getProjections, getExpenses } from '../api';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, BarChart, Bar, ReferenceLine } from 'recharts';
import { TrendingUp, TrendingDown, AlertTriangle, Award, DollarSign, Target, Clock } from 'lucide-react';

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function fmtK(n) { return n >= 1000 ? '$' + (n / 1000).toFixed(0) + 'k' : fmtMoney(n); }

const PACE_OPTIONS = [
  { label: '1 Week', days: 7 },
  { label: '2 Weeks', days: 14 },
  { label: '1 Month', days: 30 },
  { label: '3 Months', days: 90 },
  { label: '6 Months', days: 180 },
  { label: '1 Year', days: 365 },
];

const HORIZON_OPTIONS = [
  { label: '1 Year', months: 12 },
  { label: '2 Years', months: 24 },
  { label: '3 Years', months: 36 },
  { label: '5 Years', months: 60 },
];

export default function Projections() {
  const [data, setData] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [paceDays, setPaceDays] = useState(30);
  const [horizonMonths, setHorizonMonths] = useState(24);

  const fetchData = useCallback((pDays, hMonths, isRefresh) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    Promise.all([
      getProjections({ pace_days: pDays, months: hMonths }),
      getExpenses({ start: new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0] })
    ]).then(([p, e]) => { setData(p); setExpenses(e); })
      .catch(console.error)
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, []);

  useEffect(() => { fetchData(paceDays, horizonMonths, false); }, []);

  function changePace(days) {
    setPaceDays(days);
    fetchData(days, horizonMonths, true);
  }

  function changeHorizon(months) {
    setHorizonMonths(months);
    fetchData(paceDays, months, true);
  }

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

  const paceLabel = PACE_OPTIONS.find(p => p.days === paceDays)?.label || `${paceDays}d`;
  const finalOffset = data.projections?.[data.projections.length - 1]?.offset || 0;

  return (
    <div>
      <div className="page-header">
        <h2>Projections</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Offset growth forecast based on {paceLabel.toLowerCase()} spending pace
        </p>
      </div>

      {/* Spending pace selector */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', marginBottom: 4 }}>
              <Clock size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Spending pace based on
            </div>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {PACE_OPTIONS.map(p => (
                <button key={p.days}
                  className={`btn btn-sm ${paceDays === p.days ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ padding: '3px 10px', fontSize: '0.75rem' }}
                  onClick={() => changePace(p.days)}
                  disabled={refreshing}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', marginBottom: 4 }}>
              Projection horizon
            </div>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {HORIZON_OPTIONS.map(h => (
                <button key={h.months}
                  className={`btn btn-sm ${horizonMonths === h.months ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ padding: '3px 10px', fontSize: '0.75rem' }}
                  onClick={() => changeHorizon(h.months)}
                  disabled={refreshing}>
                  {h.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Status banner */}
      <div className="card" style={{ borderLeft: `4px solid ${statusColor}`, marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ color: statusColor }}>{statusIcon}</div>
          <div>
            <div style={{ fontSize: '0.95rem' }}>{data.message}</div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 2 }}>
              At {paceLabel.toLowerCase()} pace: spending {fmtMoney(data.daily_spend_rate)}/day ({fmtMoney(data.monthly_expenses_at_pace)}/mo)
            </div>
          </div>
        </div>
      </div>

      {/* Key numbers */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Net Income</div>
          <div className="stat-value positive">{fmtMoney(data.monthly_net_income)}/mo</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Expenses ({paceLabel} pace)</div>
          <div className="stat-value negative">{fmtMoney(data.monthly_expenses_at_pace)}/mo</div>
          <div className="card-sub">{fmtMoney(data.daily_spend_rate)}/day</div>
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
          <div className="card-sub">After {fmtMoney(data.mortgage)} mortgage</div>
        </div>
      </div>

      {/* Milestone cards */}
      {data.milestones && Object.keys(data.milestones).length > 0 && (
        <div className="stat-grid" style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>
          <div className="stat-card" style={{ borderColor: 'var(--accent)' }}>
            <div className="stat-label">Now</div>
            <div className="stat-value">{fmtMoney(data.offset_balance)}</div>
          </div>
          {Object.entries(data.milestones).map(([label, value]) => (
            <div key={label} className="stat-card" style={{ borderColor: value > data.offset_balance ? 'var(--green)' : 'var(--red)' }}>
              <div className="stat-label">In {label}</div>
              <div className={`stat-value ${value > data.offset_balance ? 'positive' : 'negative'}`}>{fmtMoney(value)}</div>
              <div className="card-sub">{value > data.offset_balance ? '+' : ''}{fmtMoney(value - data.offset_balance)} change</div>
            </div>
          ))}
        </div>
      )}

      {/* Offset projection chart */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <div className="card-title" style={{ margin: 0 }}><DollarSign size={14} /> Offset Projection</div>
          {refreshing && <div className="spinner" style={{ width: 16, height: 16 }} />}
        </div>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
          If spending continues at {paceLabel.toLowerCase()} rate: {fmtMoney(data.offset_balance)} now → {fmtMoney(finalOffset)} in {horizonMonths}mo
        </p>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={data.projections}>
            <XAxis dataKey="month" tick={{ fill: '#8b8fa3', fontSize: 10 }} interval={horizonMonths > 24 ? 5 : horizonMonths > 12 ? 2 : 0} />
            <YAxis tick={{ fill: '#8b8fa3', fontSize: 10 }} tickFormatter={v => fmtK(v)} />
            <Tooltip
              contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}
              formatter={(v, name) => [fmtMoney(v), name]}
            />
            <Legend />
            <ReferenceLine y={data.offset_balance} stroke="var(--text-muted)" strokeDasharray="4 3" strokeWidth={1} label={{ value: `Current: ${fmtK(data.offset_balance)}`, fill: 'var(--text-muted)', fontSize: 10, position: 'right' }} />
            <Line type="monotone" dataKey="offset" stroke="#6c5ce7" strokeWidth={3} name="Offset Balance" dot={horizonMonths <= 12 ? { r: 3 } : false} />
            <Line type="monotone" dataKey="interest_saved" stroke="#00cec9" strokeWidth={2} name="Interest Saved/mo" strokeDasharray="4 3" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Monthly flow breakdown */}
      <div className="card">
        <div className="card-title">Monthly Offset Flow ({paceLabel} pace)</div>
        <div className="retention-breakdown">
          <div className="retention-row">
            <span>Income/month</span>
            <span style={{ color: 'var(--green)' }}>+{fmtMoney(data.monthly_net_income)}</span>
          </div>
          <div className="retention-row">
            <span>Expenses/month ({paceLabel} pace)</span>
            <span style={{ color: 'var(--red)' }}>−{fmtMoney(data.monthly_expenses_at_pace)}</span>
          </div>
          <div className="retention-row">
            <span>= Surplus to offset</span>
            <span style={{ color: data.monthly_surplus >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {data.monthly_surplus >= 0 ? '+' : ''}{fmtMoney(data.monthly_surplus)}
            </span>
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
                    {g.months_to_goal && g.months_to_goal <= 60 && <span style={{ marginLeft: 8, color: 'var(--accent)' }}>~{g.months_to_goal}mo to go</span>}
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
