import React, { useState, useEffect, useCallback } from 'react';
import { getProjections, getExpenses } from '../api';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, BarChart, Bar, ReferenceLine, CartesianGrid, ComposedChart } from 'recharts';
import { TrendingUp, TrendingDown, AlertTriangle, Award, DollarSign, Target, Clock, Home, Calendar, Percent, PiggyBank } from 'lucide-react';

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
  { label: '2 Years', months: 24 },
  { label: '5 Years', months: 60 },
  { label: '10 Years', months: 120 },
  { label: '15 Years', months: 180 },
  { label: '20 Years', months: 240 },
  { label: '30 Years', months: 360 },
];

export default function Projections() {
  const [data, setData] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [paceDays, setPaceDays] = useState(30);
  const [horizonMonths, setHorizonMonths] = useState(120);

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

  function changePace(days) { setPaceDays(days); fetchData(days, horizonMonths, true); }
  function changeHorizon(months) { setHorizonMonths(months); fetchData(paceDays, months, true); }

  if (loading) return <div className="loading-page"><div className="spinner" /> Loading projections...</div>;
  if (!data) return <div>Failed to load projections</div>;

  const mc = data.mortgage_config || {};
  const paceLabel = PACE_OPTIONS.find(p => p.days === paceDays)?.label || `${paceDays}d`;
  const finalOffset = data.projections?.[data.projections.length - 1]?.offset || 0;

  const benchmarks = data.benchmarks || {};
  const categoryTotals = {};
  expenses.forEach(e => { categoryTotals[e.category] = (categoryTotals[e.category] || 0) + e.amount; });
  const benchmarkComparison = Object.entries(benchmarks).map(([key, b]) => {
    const catName = b.label.replace(' & Fitness', '');
    const actual = categoryTotals[catName] || categoryTotals[b.label] || 0;
    return { category: b.label, actual: Math.round(actual), low: b.low, mid: b.mid, high: b.high };
  }).filter(b => b.actual > 0);

  const timeSavedText = mc.time_saved_years > 0
    ? `${mc.time_saved_years}yr ${mc.time_saved_months}mo`
    : mc.total_time_saved_months > 0
    ? `${mc.total_time_saved_months} months`
    : 'Calculating...';

  return (
    <div>
      <div className="page-header">
        <h2>Projections & Mortgage Impact</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          How your offset strategy is shaving years off your mortgage
        </p>
      </div>

      {/* ── MORTGAGE IMPACT HERO ── */}
      <div className="card" style={{ background: 'linear-gradient(135deg, var(--bg-card) 0%, rgba(108,92,231,0.08) 100%)', borderLeft: '4px solid var(--accent)', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.75rem' }}>
          <Home size={18} style={{ color: 'var(--accent)' }} />
          <span style={{ fontWeight: 700, fontSize: '1.05rem' }}>Mortgage Impact</span>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
            {mc.rate_percent}% variable · {fmtMoney(mc.monthly_payment)}/mo
          </span>
        </div>
        <div className="stat-grid" style={{ marginBottom: 0 }}>
          <div className="stat-card" style={{ borderColor: 'var(--green)' }}>
            <div className="stat-label"><Calendar size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />Time Saved</div>
            <div className="stat-value positive">{timeSavedText}</div>
            <div className="card-sub">off your {mc.term_years}-year mortgage</div>
          </div>
          <div className="stat-card" style={{ borderColor: 'var(--green)' }}>
            <div className="stat-label"><DollarSign size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />Interest Saved</div>
            <div className="stat-value positive">{fmtMoney(mc.total_interest_saved)}</div>
            <div className="card-sub">projected lifetime savings</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Target size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />Offset Balance</div>
            <div className="stat-value">{fmtMoney(data.offset_balance)}</div>
            <div className="card-sub">saving {fmtMoney(mc.interest_saved_monthly_now)}/mo in interest</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Calendar size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />Payoff Date</div>
            <div className="stat-value positive">{mc.projected_payoff_date ? new Date(mc.projected_payoff_date + 'T00:00:00').toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }) : '—'}</div>
            <div className="card-sub">was {mc.original_payoff_date ? new Date(mc.original_payoff_date + 'T00:00:00').toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }) : '—'}</div>
          </div>
        </div>
      </div>

      {/* ── LOAN DETAILS ROW ── */}
      <div className="stat-grid" style={{ marginBottom: '1rem' }}>
        <div className="stat-card">
          <div className="stat-label">Original Loan</div>
          <div className="stat-value">{fmtMoney(mc.original_principal)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Remaining Balance</div>
          <div className="stat-value">{fmtMoney(mc.current_balance)}</div>
          <div className="card-sub">{mc.months_elapsed} payments made</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Interest (No Offset)</div>
          <div className="stat-value negative">{fmtMoney(mc.total_interest_no_offset)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Interest (With Offset)</div>
          <div className="stat-value positive">{fmtMoney(mc.total_interest_with_offset)}</div>
        </div>
      </div>

      {/* Pace & horizon selectors */}
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

      {/* ── OFFSET vs MORTGAGE CHART ── */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <div className="card-title" style={{ margin: 0 }}><TrendingUp size={14} /> Offset vs Mortgage Balance</div>
          {refreshing && <div className="spinner" style={{ width: 16, height: 16 }} />}
        </div>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
          Your growing offset reduces the effective mortgage balance — when they meet, your mortgage is effectively paid off
        </p>
        <ResponsiveContainer width="100%" height={350}>
          <ComposedChart data={data.projections}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="month" tick={{ fill: '#8b8fa3', fontSize: 10 }} interval={Math.max(1, Math.floor(data.projections.length / 12))} />
            <YAxis tick={{ fill: '#8b8fa3', fontSize: 10 }} tickFormatter={v => fmtK(v)} />
            <Tooltip
              contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}
              formatter={(v, name) => [fmtMoney(v), name]}
            />
            <Legend />
            <Area type="monotone" dataKey="offset" stroke="#6c5ce7" fill="rgba(108,92,231,0.15)" strokeWidth={2} name="Offset Balance" dot={false} />
            <Line type="monotone" dataKey="mortgage_remaining" stroke="#d63031" strokeWidth={2} name="Mortgage (with offset)" dot={false} />
            <Line type="monotone" dataKey="mortgage_no_offset" stroke="#636e72" strokeWidth={1} strokeDasharray="6 3" name="Mortgage (no offset)" dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* ── SAVINGS RATE ── */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="card-title"><PiggyBank size={14} /> Savings Rate</div>
        <div className="stat-grid" style={{ marginBottom: '0.5rem' }}>
          <div className="stat-card">
            <div className="stat-label">Net Savings Rate</div>
            <div className={`stat-value ${(data.savings_rate?.monthly_net || 0) >= 0 ? 'positive' : 'negative'}`}>
              {(data.savings_rate?.monthly_net || 0) >= 0 ? '+' : ''}{fmtMoney(data.savings_rate?.monthly_net || 0)}/mo
            </div>
            <div className="card-sub">Average over last 3 months</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Added to Offset (3mo)</div>
            <div className="stat-value positive">+{fmtMoney(data.savings_rate?.total_added_3mo || 0)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Mortgage Debits (3mo)</div>
            <div className="stat-value negative">−{fmtMoney(data.savings_rate?.total_debited_3mo || 0)}</div>
          </div>
        </div>
      </div>

      {/* ── MONTHLY FLOW ── */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="card-title">Monthly Offset Flow ({paceLabel} pace)</div>
        <div className="retention-breakdown">
          <div className="retention-row">
            <span>Household income/mo</span>
            <span style={{ color: 'var(--green)' }}>+{fmtMoney(data.monthly_net_income)}</span>
          </div>
          <div className="retention-row">
            <span>Expenses/mo ({paceLabel} pace)</span>
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
            <span>Net offset growth/mo</span>
            <span style={{ color: data.net_offset_growth >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {data.net_offset_growth >= 0 ? '+' : ''}{fmtMoney(data.net_offset_growth)}
            </span>
          </div>
        </div>
      </div>

      {/* ── WHAT-IF SCENARIOS ── */}
      {data.scenarios && data.scenarios.length > 0 && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <div className="card-title"><TrendingUp size={14} /> What-If Scenarios</div>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            How extra savings would accelerate your mortgage payoff
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Scenario</th><th>Extra $/mo</th><th>Payoff In</th><th>Time Saved</th><th>Interest Saved</th></tr>
              </thead>
              <tbody>
                {data.scenarios.map((s, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{s.label}</td>
                    <td style={{ color: 'var(--green)' }}>+{fmtMoney(s.monthly_saving)}</td>
                    <td>{Math.floor(s.payoff_months / 12)}yr {s.payoff_months % 12}mo</td>
                    <td style={{ color: 'var(--green)', fontWeight: 600 }}>
                      {s.time_saved_years > 0 ? `${s.time_saved_years}yr ${s.time_saved_rem_months}mo` : `${s.time_saved_months || 0}mo`}
                    </td>
                    <td style={{ color: 'var(--green)', fontWeight: 600 }}>{fmtMoney(s.interest_saved)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── MILESTONE CARDS ── */}
      {data.milestones && Object.keys(data.milestones).length > 0 && (
        <div className="stat-grid" style={{ marginBottom: '1rem' }}>
          <div className="stat-card" style={{ borderColor: 'var(--accent)' }}>
            <div className="stat-label">Offset Now</div>
            <div className="stat-value">{fmtMoney(data.offset_balance)}</div>
          </div>
          {Object.entries(data.milestones).map(([label, value]) => (
            <div key={label} className="stat-card" style={{ borderColor: value > data.offset_balance ? 'var(--green)' : 'var(--red)' }}>
              <div className="stat-label">In {label}</div>
              <div className={`stat-value ${value > data.offset_balance ? 'positive' : 'negative'}`}>{fmtMoney(value)}</div>
              <div className="card-sub">{value > data.offset_balance ? '+' : ''}{fmtMoney(value - data.offset_balance)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Goal achievement */}
      {data.goals?.length > 0 && (
        <div className="card" style={{ marginBottom: '1rem' }}>
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

      {/* Benchmarks table */}
      {benchmarkComparison.length > 0 && (
        <div className="card" style={{ marginBottom: '1rem' }}>
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
