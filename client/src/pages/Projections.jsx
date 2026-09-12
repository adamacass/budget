import React, { useState, useEffect, useCallback } from 'react';
import { getProjections, getExpenses } from '../api';
import {
  Area, Line, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  CartesianGrid, ComposedChart
} from 'recharts';
import {
  TrendingUp, TrendingDown, Minus, AlertTriangle, DollarSign, Target, Clock,
  Home, PiggyBank, Repeat, Wallet, Shield, Info, CheckCircle
} from 'lucide-react';
import { getCategoryColor } from '../categoryColors';

function fmtMoney(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtMoney2(n) {
  return '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtK(n) {
  const v = Number(n) || 0;
  return Math.abs(v) >= 10000 ? '$' + Math.round(v / 1000) + 'k' : fmtMoney(v);
}
function fmtSigned(n) {
  const v = Math.round(Number(n) || 0);
  return (v > 0 ? '+' : v < 0 ? '−' : '') + fmtMoney(Math.abs(v));
}
// 'YYYY-MM' or 'YYYY-MM-DD' -> 'Sep 25'
function fmtMonth(s) {
  if (!s || typeof s !== 'string') return '';
  const d = new Date((s.length === 7 ? s + '-01' : s) + 'T00:00:00');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' });
}
function fmtMonthYear(s) {
  if (!s || typeof s !== 'string') return '—';
  const d = new Date((s.length === 7 ? s + '-01' : s) + 'T00:00:00');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
}
function fmtDate(s) {
  if (!s || typeof s !== 'string') return '—';
  const d = new Date(s.substring(0, 10) + 'T00:00:00');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDuration(months) {
  const m = Math.max(0, Math.round(Number(months) || 0));
  const y = Math.floor(m / 12);
  const rem = m % 12;
  if (y > 0 && rem > 0) return `${y}yr ${rem}mo`;
  if (y > 0) return `${y}yr`;
  return `${m}mo`;
}

const HORIZON_OPTIONS = [
  { label: '2yr', months: 24 },
  { label: '5yr', months: 60 },
  { label: '10yr', months: 120 },
  { label: '15yr', months: 180 },
  { label: '20yr', months: 240 },
  { label: '30yr', months: 360 },
];

const PACE_OPTIONS = [
  { label: '2wk', days: 14 },
  { label: '1mo', days: 30 },
  { label: '3mo', days: 90 },
  { label: '6mo', days: 180 },
  { label: '1yr', days: 365 },
];

const BASIS_OPTIONS = [
  {
    key: 'actual',
    label: 'Measured',
    blurb: 'What really happened: money actually transferred into the offset, less what was actually withdrawn. The most honest number, and the hardest to flatter.',
  },
  {
    key: 'estimated',
    label: 'Estimated',
    blurb: 'Take-home pay after tax and HECS, minus your recent spending pace. Optimistic if some spending never gets logged.',
  },
  {
    key: 'budget',
    label: 'Budget',
    blurb: 'Take-home pay minus what your category budgets allow. This is the plan, not the reality.',
  },
];

const CHART_AXIS = { fill: 'var(--chart-text)', fontSize: 10 };
const TOOLTIP_STYLE = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: '0.8rem',
  color: 'var(--text)',
};

function SectionNote({ children }) {
  return (
    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
      {children}
    </p>
  );
}

export default function Projections() {
  const [data, setData] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [basis, setBasis] = useState('actual');
  const [paceDays, setPaceDays] = useState(30);
  const [horizonMonths, setHorizonMonths] = useState(120);
  const [showAllRecurring, setShowAllRecurring] = useState(false);

  const fetchData = useCallback((opts, isRefresh) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError('');
    Promise.all([
      getProjections({ pace_days: opts.paceDays, months: opts.horizonMonths, basis: opts.basis }),
      getExpenses({ start: new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0] }).catch(() => []),
    ])
      .then(([p, e]) => { setData(p || null); setExpenses(Array.isArray(e) ? e : []); })
      .catch(err => { console.error(err); setError(err?.message || 'Could not load projections'); })
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, []);

  useEffect(() => { fetchData({ paceDays: 30, horizonMonths: 120, basis: 'actual' }, false); }, [fetchData]);

  function changeBasis(next) { setBasis(next); fetchData({ paceDays, horizonMonths, basis: next }, true); }
  function changePace(days) { setPaceDays(days); fetchData({ paceDays: days, horizonMonths, basis }, true); }
  function changeHorizon(months) { setHorizonMonths(months); fetchData({ paceDays, horizonMonths: months, basis }, true); }

  if (loading) return <div className="loading-page"><div className="spinner" /> Loading projections...</div>;

  if (error || !data) {
    return (
      <div>
        <div className="page-header"><h2>Long-Term Projections</h2></div>
        <div className="card">
          <div className="card-title"><AlertTriangle size={14} /> Couldn't load projections</div>
          <SectionNote>{error || 'The server returned no data.'}</SectionNote>
          <button className="btn btn-primary btn-sm" onClick={() => fetchData({ paceDays, horizonMonths, basis }, false)}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  // ─────────────────────────── derived, all guarded ───────────────────────────
  const mc = data.mortgage_config || {};
  const patterns = data.patterns || {};
  const basisOptions = data.basis_options || {};
  const basisDetail = data.basis_detail || {};
  const activeBasis = data.basis || basis;
  const haveActuals = !!basisDetail.have_actuals;
  const fellBack = activeBasis === 'actual' && !haveActuals;
  const observedMonths = Number(basisDetail.observed_months) || 0;

  const projections = Array.isArray(data.projections) ? data.projections : [];
  const monthlyHistory = Array.isArray(patterns.monthly_history) ? patterns.monthly_history : [];
  const movers = Array.isArray(patterns.category_movers) ? patterns.category_movers : [];
  const recurring = Array.isArray(patterns.recurring_commitments) ? patterns.recurring_commitments : [];
  const savingHistory = Array.isArray(patterns.saving_history) ? patterns.saving_history : [];
  const planned = Array.isArray(data.planned_withdrawals) ? data.planned_withdrawals : [];
  const scenarios = Array.isArray(data.scenarios) ? data.scenarios : [];
  const goals = Array.isArray(data.goals) ? data.goals : [];
  const milestones = data.milestones && typeof data.milestones === 'object' ? data.milestones : {};

  const savedMonths = Number(mc.total_time_saved_months) || 0;
  const surplus = Number(data.monthly_surplus) || 0;
  const offsetBalance = Number(data.offset_balance) || 0;
  const status = data.status || 'okay';
  const statusColor = status === 'great' ? 'var(--green)' : status === 'warning' ? 'var(--red)' : 'var(--yellow)';

  const trendPct = Number(patterns.spend_trend_pct) || 0;
  const direction = patterns.spend_direction || 'steady';
  const trendColor = direction === 'rising' ? 'var(--red)' : direction === 'falling' ? 'var(--green)' : 'var(--text-muted)';
  const TrendIcon = direction === 'rising' ? TrendingUp : direction === 'falling' ? TrendingDown : Minus;
  const trendText = direction === 'rising'
    ? `Spending is rising — up ${Math.abs(trendPct)}% on the last 3 months vs the 3 before.`
    : direction === 'falling'
    ? `Spending is falling — down ${Math.abs(trendPct)}% on the last 3 months vs the 3 before.`
    : 'Spending is steady — the last 3 months look much like the 3 before.';

  const bufferMonths = patterns.months_of_expenses_in_offset;
  const hasBuffer = bufferMonths !== null && bufferMonths !== undefined && !isNaN(Number(bufferMonths));

  // Spend history chart data (labelled, current partial month flagged)
  const currentMonthKey = new Date().toISOString().substring(0, 7);
  const savingByMonth = {};
  savingHistory.forEach(s => { if (s && s.month) savingByMonth[s.month] = Number(s.total) || 0; });
  const historyChart = monthlyHistory.map(m => ({
    label: fmtMonth(m?.month),
    month: m?.month || '',
    total: Number(m?.total) || 0,
    core_total: Number(m?.core_total) || 0,
    saved: savingByMonth[m?.month] || 0,
    partial: m?.month === currentMonthKey,
  }));

  // Benchmarks vs the last 30 days of real spending
  const benchmarks = data.benchmarks && typeof data.benchmarks === 'object' ? data.benchmarks : {};
  const categoryTotals = {};
  expenses.forEach(e => {
    if (!e || !e.category) return;
    categoryTotals[e.category] = (categoryTotals[e.category] || 0) + (Number(e.amount) || 0);
  });
  const benchmarkRows = Object.entries(benchmarks).map(([key, b]) => {
    const label = (b && b.label) || key;
    const plain = label.replace(' & Fitness', '');
    const actual = Math.round(categoryTotals[plain] || categoryTotals[label] || 0);
    return { category: label, actual, low: Number(b?.low) || 0, mid: Number(b?.mid) || 0, high: Number(b?.high) || 0 };
  }).filter(b => b.actual > 0).sort((a, b) => b.actual - a.actual);

  const milestoneEntries = Object.entries(milestones);
  const visibleRecurring = showAllRecurring ? recurring : recurring.slice(0, 6);

  return (
    <div>
      <div className="page-header">
        <h2>Long-Term Projections</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Where the offset strategy takes you, and what your spending and saving actually look like
        </p>
      </div>

      {/* ═══════════ 1. HERO — MORTGAGE IMPACT ═══════════ */}
      <div
        className="card"
        style={{
          background: 'linear-gradient(135deg, var(--bg-card) 0%, rgba(108,92,231,0.10) 100%)',
          borderLeft: '4px solid var(--accent)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          <Home size={18} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span style={{ fontWeight: 700, fontSize: '1.05rem' }}>Mortgage Impact</span>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
            {mc.rate_percent != null ? `${mc.rate_percent}%` : '—'} · {fmtMoney(mc.monthly_payment)}/mo
            {mc.term_years ? ` · ${mc.term_years}yr term` : ''}
          </span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.25rem', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)' }}>
              Mortgage-free earlier by
            </div>
            <div style={{
              fontSize: 'clamp(2.2rem, 11vw, 3.4rem)',
              fontWeight: 800,
              lineHeight: 1.05,
              color: savedMonths > 0 ? 'var(--green)' : 'var(--text)',
              wordBreak: 'break-word',
            }}>
              {savedMonths > 0 ? fmtDuration(savedMonths) : 'On schedule'}
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: 4 }}>
              Paid off <strong style={{ color: 'var(--text)' }}>{fmtMonthYear(mc.projected_payoff_date)}</strong>
              {mc.original_payoff_date ? <> instead of {fmtMonthYear(mc.original_payoff_date)}</> : null}
            </div>
          </div>

          <div style={{ flex: '2 1 320px', minWidth: 0, display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
            <div style={{ flex: '1 1 130px', minWidth: 0 }}>
              <div className="stat-label">Interest saved</div>
              <div style={{ fontSize: '1.35rem', fontWeight: 700, color: 'var(--green)' }}>{fmtMoney(mc.total_interest_saved)}</div>
              <div className="card-sub">over the life of the loan</div>
            </div>
            <div style={{ flex: '1 1 130px', minWidth: 0 }}>
              <div className="stat-label">Saving right now</div>
              <div style={{ fontSize: '1.35rem', fontWeight: 700, color: 'var(--green)' }}>{fmtMoney(mc.interest_saved_monthly_now)}<span style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-muted)' }}>/mo</span></div>
              <div className="card-sub">from {fmtMoney(offsetBalance)} in offset</div>
            </div>
            <div style={{ flex: '1 1 130px', minWidth: 0 }}>
              <div className="stat-label">Balance owing</div>
              <div style={{ fontSize: '1.35rem', fontWeight: 700 }}>{fmtMoney(mc.current_balance)}</div>
              <div className="card-sub">
                of {fmtMoney(mc.original_principal)}
                {mc.months_elapsed ? ` · ${mc.months_elapsed} paid` : ''}
              </div>
            </div>
          </div>
        </div>

        {data.message && (
          <div style={{
            marginTop: '1rem',
            paddingTop: '0.75rem',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            fontSize: '0.85rem',
            color: 'var(--text)',
          }}>
            {status === 'warning'
              ? <AlertTriangle size={16} style={{ color: statusColor, flexShrink: 0, marginTop: 2 }} />
              : <CheckCircle size={16} style={{ color: statusColor, flexShrink: 0, marginTop: 2 }} />}
            <span>{data.message}</span>
          </div>
        )}
      </div>

      {/* ═══════════ 2. BASIS — WHAT DRIVES THE PROJECTION ═══════════ */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div className="card-title" style={{ margin: 0 }}><Info size={14} /> What these numbers are built on</div>
          {refreshing && <div className="spinner" style={{ width: 16, height: 16 }} />}
        </div>
        <SectionNote>
          Every projection on this page runs off one number: how much you add to the offset each month. Pick how that
          number is worked out — they can differ a lot.
        </SectionNote>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
          {BASIS_OPTIONS.map(opt => {
            const value = basisOptions[opt.key];
            const isActive = activeBasis === opt.key;
            return (
              <button
                key={opt.key}
                className={`btn ${isActive ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => changeBasis(opt.key)}
                disabled={refreshing}
                style={{
                  flex: '1 1 130px',
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 2,
                  padding: '0.6rem 0.75rem',
                  textAlign: 'left',
                }}
              >
                <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.85 }}>{opt.label}</span>
                <span style={{ fontSize: '1.05rem', fontWeight: 700 }}>
                  {value == null ? '—' : `${fmtSigned(value)}/mo`}
                </span>
              </button>
            );
          })}
        </div>

        <SectionNote>
          {BASIS_OPTIONS.find(o => o.key === activeBasis)?.blurb || ''}
        </SectionNote>

        {fellBack ? (
          <div style={{
            display: 'flex', gap: 8, alignItems: 'flex-start',
            fontSize: '0.82rem', color: 'var(--text)',
            background: 'var(--yellow-bg)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', padding: '0.6rem 0.75rem', marginBottom: '0.75rem',
          }}>
            <AlertTriangle size={15} style={{ color: 'var(--yellow)', flexShrink: 0, marginTop: 2 }} />
            <span>
              No real offset transfers have been recorded yet, so the measured figure can't be worked out. The
              projection has fallen back to the <strong>estimate</strong> ({fmtSigned(basisOptions.estimated)}/mo).
              Log a payday with an offset transfer and this becomes a real measurement.
            </span>
          </div>
        ) : (
          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            Measured figure is backed by <strong style={{ color: 'var(--text)' }}>{observedMonths}</strong> month{observedMonths === 1 ? '' : 's'} of real
            pay data: {fmtMoney(basisDetail.actual_monthly_in)}/mo in, {fmtMoney(basisDetail.actual_monthly_withdrawn)}/mo withdrawn.
            {observedMonths < 3 && ' With this little history, treat the long-range figures as a sketch.'}
          </div>
        )}

        <div className="retention-breakdown" style={{ marginBottom: '0.75rem' }}>
          <div className="retention-row">
            <span>Take-home income / month</span>
            <span style={{ color: 'var(--green)' }}>{fmtSigned(data.monthly_net_income)}</span>
          </div>
          <div className="retention-row">
            <span>Spending at current pace ({paceDays}d)</span>
            <span style={{ color: 'var(--red)' }}>{fmtSigned(-(Number(data.monthly_expenses_at_pace) || 0))}</span>
          </div>
          <div className="retention-row">
            <span>Budgeted spending, for comparison</span>
            <span style={{ color: 'var(--text-muted)' }}>{fmtMoney(data.budgeted_expenses)}</span>
          </div>
          <div className="retention-row">
            <span>Mortgage auto-debit</span>
            <span style={{ color: 'var(--red)' }}>{fmtSigned(-(Number(data.mortgage) || 0))}</span>
          </div>
          <div className="retention-row total">
            <span>Surplus driving the projection</span>
            <span style={{ color: surplus >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmtSigned(surplus)}/mo</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Clock size={12} /> Spending pace measured over
          </span>
          {PACE_OPTIONS.map(p => (
            <button
              key={p.days}
              className={`btn btn-sm ${paceDays === p.days ? 'btn-primary' : 'btn-ghost'}`}
              style={{ padding: '2px 10px', fontSize: '0.72rem' }}
              onClick={() => changePace(p.days)}
              disabled={refreshing}
            >
              {p.label}
            </button>
          ))}
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            = {fmtMoney(data.daily_spend_rate)}/day
          </span>
        </div>
      </div>

      {/* ═══════════ 3. OFFSET vs MORTGAGE ═══════════ */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div className="card-title" style={{ margin: 0 }}><TrendingUp size={14} /> Offset vs Mortgage</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {HORIZON_OPTIONS.map(h => (
              <button
                key={h.months}
                className={`btn btn-sm ${horizonMonths === h.months ? 'btn-primary' : 'btn-ghost'}`}
                style={{ padding: '2px 9px', fontSize: '0.72rem' }}
                onClick={() => changeHorizon(h.months)}
                disabled={refreshing}
              >
                {h.label}
              </button>
            ))}
          </div>
        </div>
        <SectionNote>
          Your offset grows while the loan shrinks. Where the two lines meet, the mortgage is effectively gone — the
          grey dashed line is where you'd be without the offset.
        </SectionNote>

        {projections.length === 0 ? (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No projection data available.</div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={projections} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="projOffsetGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6c5ce7" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="#6c5ce7" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="month"
                tick={CHART_AXIS}
                tickFormatter={fmtMonth}
                interval={Math.max(0, Math.floor(projections.length / 6))}
                axisLine={false}
                tickLine={false}
              />
              <YAxis tick={CHART_AXIS} tickFormatter={fmtK} width={50} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                labelFormatter={fmtMonthYear}
                formatter={(v, name) => [fmtMoney(v), name]}
              />
              <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
              <Area type="monotone" dataKey="offset" stroke="#6c5ce7" fill="url(#projOffsetGrad)" strokeWidth={2} name="Offset balance" dot={false} />
              <Line type="monotone" dataKey="mortgage_remaining" stroke="#d63031" strokeWidth={2} name="Mortgage (with offset)" dot={false} />
              <Line type="monotone" dataKey="mortgage_no_offset" stroke="#636e72" strokeWidth={1.5} strokeDasharray="6 3" name="Mortgage (no offset)" dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}

        {milestoneEntries.length > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: '0.75rem 1.5rem',
            marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)',
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.6 }}>Offset now</div>
              <div style={{ fontSize: '1rem', fontWeight: 700 }}>{fmtMoney(offsetBalance)}</div>
            </div>
            {milestoneEntries.map(([label, value]) => {
              const v = Number(value) || 0;
              const delta = v - offsetBalance;
              return (
                <div key={label} style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.6 }}>In {label}</div>
                  <div style={{ fontSize: '1rem', fontWeight: 700, color: delta >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmtMoney(v)}</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{fmtSigned(delta)}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ═══════════ 4. SPENDING & SAVING PATTERNS ═══════════ */}
      <div className="card">
        <div className="card-title"><TrendingUp size={14} /> Spending Patterns</div>

        <div style={{
          display: 'flex', gap: 8, alignItems: 'flex-start',
          padding: '0.6rem 0.75rem', marginBottom: '0.75rem',
          border: '1px solid var(--border)', borderLeft: `3px solid ${trendColor}`,
          borderRadius: 'var(--radius)',
        }}>
          <TrendIcon size={16} style={{ color: trendColor, flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: '0.85rem', minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{trendText}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 2 }}>
              {fmtMoney(patterns.avg_last_3mo)}/mo recently vs {fmtMoney(patterns.avg_prev_3mo)}/mo before
              {' · '}12-month average {fmtMoney(patterns.avg_monthly_spend)}/mo
              {patterns.weekend_share_pct ? ` · ${patterns.weekend_share_pct}% of it lands on weekends` : ''}
            </div>
          </div>
        </div>

        {historyChart.length === 0 ? (
          <SectionNote>No spending history yet — log a few months of expenses and the trend will appear here.</SectionNote>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={historyChart} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={CHART_AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
                <YAxis tick={CHART_AXIS} tickFormatter={fmtK} width={50} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v, name) => [fmtMoney(v), name]}
                />
                <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
                <Bar dataKey="total" fill="#6c5ce7" name="Total spent" radius={[3, 3, 0, 0]} />
                <Line type="monotone" dataKey="core_total" stroke="#fdcb6e" strokeWidth={2} name="Day-to-day spend" dot={false} />
                {savingHistory.length > 0 && (
                  <Line type="monotone" dataKey="saved" stroke="#00b894" strokeWidth={2} strokeDasharray="5 3" name="Saved to offset" dot={false} />
                )}
              </ComposedChart>
            </ResponsiveContainer>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
              The final bar is the month in progress, so it will look low until the month closes.
            </div>
          </>
        )}
      </div>

      <div className="grid-2">
        {/* Category movers */}
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="card-title"><TrendingUp size={14} /> What Changed</div>
          <SectionNote>Average monthly spend in the last 90 days vs the 90 before it.</SectionNote>
          {movers.length === 0 ? (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Not enough history to compare yet.</div>
          ) : (
            <div>
              {movers.map((m, i) => {
                const change = Number(m?.change) || 0;
                const up = change > 0;
                const colour = change === 0 ? 'var(--text-muted)' : up ? 'var(--red)' : 'var(--green)';
                const Icon = change === 0 ? Minus : up ? TrendingUp : TrendingDown;
                return (
                  <div
                    key={(m?.category || 'cat') + i}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.5rem',
                      padding: '0.4rem 0', borderBottom: i < movers.length - 1 ? '1px solid var(--border)' : 'none',
                      fontSize: '0.85rem', flexWrap: 'wrap',
                    }}
                  >
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                      background: getCategoryColor(m?.category),
                    }} />
                    <span style={{ fontWeight: 600, flex: '1 1 90px', minWidth: 0 }}>{m?.category || 'Other'}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
                      {fmtMoney(m?.monthly_before)} &rarr; {fmtMoney(m?.monthly_now)}
                    </span>
                    <span style={{
                      display: 'flex', alignItems: 'center', gap: 3, color: colour,
                      fontWeight: 700, whiteSpace: 'nowrap', minWidth: 76, justifyContent: 'flex-end',
                    }}>
                      <Icon size={13} />
                      {fmtSigned(change)}
                      {m?.change_pct != null && (
                        <span style={{ fontSize: '0.72rem', fontWeight: 500, opacity: 0.85 }}>
                          ({m.change_pct > 0 ? '+' : ''}{m.change_pct}%)
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recurring commitments */}
        <div className="card" style={{ marginBottom: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div className="card-title" style={{ margin: 0 }}><Repeat size={14} /> Locked-In Each Month</div>
            <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--accent)' }}>
              {fmtMoney(patterns.recurring_monthly_total)}<span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-muted)' }}>/mo</span>
            </div>
          </div>
          <SectionNote>Charges that repeat at a steady amount — subscriptions, memberships, regular bills.</SectionNote>
          {recurring.length === 0 ? (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              No repeating charges detected in the last 12 months.
            </div>
          ) : (
            <>
              <div>
                {visibleRecurring.map((r, i) => (
                  <div
                    key={(r?.description || 'item') + i}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
                      padding: '0.4rem 0',
                      borderBottom: i < visibleRecurring.length - 1 ? '1px solid var(--border)' : 'none',
                      fontSize: '0.85rem',
                    }}
                  >
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                      background: getCategoryColor(r?.category),
                    }} />
                    <span style={{ flex: '1 1 110px', minWidth: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>
                      {r?.description || 'Unnamed'}
                    </span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {r?.hits || 0}&times; &middot; last {fmtDate(r?.last_seen)}
                    </span>
                    <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{fmtMoney2(r?.avg_amount)}</span>
                  </div>
                ))}
              </div>
              {recurring.length > 6 && (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ marginTop: '0.5rem', padding: '2px 10px', fontSize: '0.72rem' }}
                  onClick={() => setShowAllRecurring(v => !v)}
                >
                  {showAllRecurring ? 'Show fewer' : `Show all ${recurring.length}`}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Saving habit */}
      <div className="card">
        <div className="card-title"><PiggyBank size={14} /> Saving Habit</div>
        <div className="stat-grid" style={{ marginBottom: 0 }}>
          <div className="stat-card">
            <div className="stat-label">Average saved</div>
            <div className="stat-value positive">{fmtMoney(patterns.avg_monthly_saved)}<span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>/mo</span></div>
            <div className="card-sub">into the offset, whole months only</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Consistency</div>
            <div className="stat-value" style={{ textTransform: 'capitalize' }}>{patterns.saving_consistency || 'no data'}</div>
            <div className="card-sub">how much month-to-month wobble there is</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Shield size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />Safety buffer</div>
            <div className="stat-value" style={{ color: !hasBuffer ? 'var(--text-muted)' : Number(bufferMonths) >= 6 ? 'var(--green)' : Number(bufferMonths) >= 3 ? 'var(--yellow)' : 'var(--red)' }}>
              {hasBuffer ? `${bufferMonths} mo` : '—'}
            </div>
            <div className="card-sub">of average spending sitting in the offset</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Last 3 months</div>
            <div className={`stat-value ${(Number(data.savings_rate?.monthly_net) || 0) >= 0 ? 'positive' : 'negative'}`}>
              {fmtSigned(data.savings_rate?.monthly_net)}<span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>/mo</span>
            </div>
            <div className="card-sub">
              {fmtMoney(data.savings_rate?.total_added_3mo)} in, {fmtMoney(data.savings_rate?.total_debited_3mo)} out
            </div>
          </div>
        </div>
      </div>

      {/* ═══════════ 5. PLANNED WITHDRAWALS ═══════════ */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div className="card-title" style={{ margin: 0 }}><Wallet size={14} /> Planned Withdrawals</div>
          {planned.length > 0 && (
            <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--red)' }}>
              {fmtMoney(data.planned_withdrawals_total)}
            </div>
          )}
        </div>
        {planned.length === 0 ? (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Nothing planned — the projection assumes no money leaves the offset except the mortgage.
          </div>
        ) : (
          <>
            <SectionNote>
              Already subtracted from the projection above, in the month each one falls due. Manage these on the Offset page.
            </SectionNote>
            <div>
              {planned.map((p, i) => (
                <div
                  key={p?.id ?? i}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
                    padding: '0.45rem 0',
                    borderBottom: i < planned.length - 1 ? '1px solid var(--border)' : 'none',
                    fontSize: '0.85rem',
                  }}
                >
                  <span style={{ flex: '1 1 120px', minWidth: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>{p?.label || 'Withdrawal'}</span>
                  {p?.recurring && (Number(p?.frequency_months) || 0) > 0 ? (
                    <span className="tag tag-blue">every {p.frequency_months} mo</span>
                  ) : (
                    <span className="tag tag-purple">{fmtDate(p?.target_date)}</span>
                  )}
                  <span style={{ fontWeight: 700, color: 'var(--red)', whiteSpace: 'nowrap' }}>{fmtSigned(-(Number(p?.amount) || 0))}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ═══════════ 6. WHAT-IF SCENARIOS ═══════════ */}
      {scenarios.length > 0 && (
        <div className="card">
          <div className="card-title"><Target size={14} /> What If You Saved More?</div>
          <SectionNote>Each row adds to the {fmtSigned(surplus)}/mo above and re-runs the whole projection.</SectionNote>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Extra / mo</th>
                  <th>Paid off in</th>
                  <th>Time saved</th>
                  <th>Interest saved</th>
                </tr>
              </thead>
              <tbody>
                {scenarios.map((s, i) => (
                  <tr key={(s?.label || 'scenario') + i}>
                    <td style={{ fontWeight: 600 }}>{s?.label || '—'}</td>
                    <td style={{ color: 'var(--green)', whiteSpace: 'nowrap' }}>{fmtSigned(s?.monthly_saving)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDuration(s?.payoff_months)}</td>
                    <td style={{ color: 'var(--green)', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtDuration(s?.time_saved_months)}</td>
                    <td style={{ color: 'var(--green)', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtMoney(s?.interest_saved)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ═══════════ 7. GOALS ═══════════ */}
      {goals.length > 0 && (
        <div className="card">
          <div className="card-title"><Target size={14} /> Goal Forecast</div>
          <SectionNote>
            The surplus is shared between unfinished goals by priority. Change a goal's priority to shift the split.
          </SectionNote>
          {goals.map((g, i) => {
            const target = Number(g?.target_amount) || 0;
            const current = Number(g?.current_amount) || 0;
            const pct = target > 0 ? (current / target) * 100 : 0;
            const done = target > 0 && current >= target;
            const months = g?.months_to_goal;
            return (
              <div key={g?.id ?? i} style={{ marginBottom: i < goals.length - 1 ? '1rem' : 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap', fontSize: '0.85rem', marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' }}>{g?.name || 'Goal'}</span>
                  <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {fmtMoney(current)} / {fmtMoney(target)}
                  </span>
                </div>
                <div className="progress-bar" style={{ height: 10, margin: '0 0 4px' }}>
                  <div
                    className={`progress-fill ${pct >= 75 ? 'green' : pct >= 40 ? 'yellow' : ''}`}
                    style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  <span>
                    {done
                      ? 'Funded'
                      : <>{fmtMoney(g?.remaining)} to go &middot; {fmtMoney(g?.monthly_contribution)}/mo allocated</>}
                  </span>
                  <span>
                    {done
                      ? <span style={{ color: 'var(--green)', fontWeight: 600 }}>Complete</span>
                      : months == null
                      ? 'No ETA — nothing is being allocated to this goal'
                      : <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                          {fmtDuration(months)} away{g?.eta ? ` · ${fmtMonthYear(g.eta)}` : ''}
                        </span>}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ═══════════ 8. BENCHMARKS ═══════════ */}
      {benchmarkRows.length > 0 && (
        <div className="card">
          <div className="card-title"><DollarSign size={14} /> Against Sydney Households</div>
          <SectionNote>Your last 30 days of spending against typical Sydney household ranges.</SectionNote>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Category</th>
                  <th>You</th>
                  <th>Typical range</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {benchmarkRows.map(b => {
                  const level = b.actual <= b.low ? 'green' : b.actual <= b.high ? 'yellow' : 'red';
                  const verdict = level === 'green' ? 'Below average' : level === 'yellow' ? 'Typical' : 'Above average';
                  const colour = level === 'green' ? 'var(--green)' : level === 'yellow' ? 'var(--yellow)' : 'var(--red)';
                  return (
                    <tr key={b.category}>
                      <td style={{ fontWeight: 600 }}>{b.category}</td>
                      <td style={{ fontWeight: 700, color: colour, whiteSpace: 'nowrap' }}>{fmtMoney(b.actual)}</td>
                      <td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmtMoney(b.low)} &ndash; {fmtMoney(b.high)}</td>
                      <td><span className={`tag tag-${level}`}>{verdict}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
