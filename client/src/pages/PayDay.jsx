import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { getIncome, getBalances, getRetention, getAccountSweepAdvice, getUpcomingExpenses, addUpcomingExpense, resolveUpcomingExpense, completePayDay, getGoals, getOffsetContributions } from '../api';
import { Wallet, CheckCircle, Plus, X, ArrowRightLeft, TrendingUp, Shield, Target, ChevronDown, ChevronUp, Home, Clock, Users, Zap, Award } from 'lucide-react';

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtK(n) { return n >= 1000 ? '$' + (n / 1000).toFixed(0) + 'k' : fmtMoney(n); }
function fmtMoneyShort(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }

// Interest savings calculator: how much does $X in offset save over time?
// Offset reduces effective mortgage principal → saves principal * rate per year
// Over multiple years with monthly compounding of savings
function calcInterestSaved(amount, rate, years) {
  // Each year you save amount * rate in interest. Over Y years = amount * rate * Y
  // (Simplified — offset is a direct principal reduction, not compounding)
  return amount * rate * years;
}

// Milestone thresholds for offset balance celebrations
const MILESTONES = [10000, 25000, 50000, 75000, 100000, 150000, 200000, 250000, 300000, 400000, 500000];
function getMilestone(currentBalance, newBalance) {
  for (const m of MILESTONES) {
    if (currentBalance < m && newBalance >= m) return m;
  }
  return null;
}

export default function PayDay() {
  const { user } = useAuth();
  const [mode, setMode] = useState('payday');
  const [step, setStep] = useState(1);
  const [netPay, setNetPay] = useState('');
  const [grossPay, setGrossPay] = useState('');
  const [payDate, setPayDate] = useState(new Date().toISOString().split('T')[0]);
  const [payType, setPayType] = useState('regular');
  const [notes, setNotes] = useState('');
  const [balances, setBalances] = useState({});
  const [retention, setRetention] = useState(null);
  const [retentionOverride, setRetentionOverride] = useState('');
  const [upcoming, setUpcoming] = useState([]);
  const [showAddUpcoming, setShowAddUpcoming] = useState(false);
  const [upcomingForm, setUpcomingForm] = useState({ description: '', estimated_amount: '', expected_date: '', category: '', notes: '' });
  const [goals, setGoals] = useState([]);
  const [goalAllocations, setGoalAllocations] = useState({});
  const [saved, setSaved] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);
  // History
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  // Contributions breakdown
  const [contributions, setContributions] = useState(null);
  const [showContributions, setShowContributions] = useState(false);
  // Sweep mode
  const [txnBalance, setTxnBalance] = useState('');
  const [sweepAmount, setSweepAmount] = useState('');
  const [sweepAdvice, setSweepAdvice] = useState(null);
  const [sweepLoading, setSweepLoading] = useState(false);

  useEffect(() => {
    getBalances().then(setBalances).catch(console.error);
    getUpcomingExpenses().then(setUpcoming).catch(console.error);
    getGoals().then(setGoals).catch(console.error);
    getIncome().then(setHistory).catch(console.error);
    getOffsetContributions().then(setContributions).catch(console.error);
  }, []);

  // Estimate net pay from gross
  useEffect(() => {
    if (user && !netPay && user.gross_income) {
      const grossExSuper = user.gross_income / (1 + (user.super_rate || 0.115));
      let periods = user.pay_cycle === 'weekly' ? 52 : user.pay_cycle === 'fortnightly' ? 26 : 12;
      const grossPerPeriod = grossExSuper / periods;
      let taxable = grossExSuper;
      let tax = 0;
      if (taxable > 190000) tax = 51667 + (taxable - 190000) * 0.45;
      else if (taxable > 135000) tax = 29467 + (taxable - 135000) * 0.37;
      else if (taxable > 45000) tax = 5092 + (taxable - 45000) * 0.325;
      else if (taxable > 18200) tax = (taxable - 18200) * 0.19;
      const hecs = taxable * (user.hecs_repayment_rate || 0);
      const annualNet = taxable - tax - hecs;
      const netPerPeriod = annualNet / periods;
      setNetPay(netPerPeriod.toFixed(2));
      setGrossPay(grossPerPeriod.toFixed(2));
    }
  }, [user]);

  // Fetch retention when moving to step 2
  async function goToStep2() {
    if (!user) return;
    try {
      const ret = await getRetention(user.id);
      setRetention(ret);
      setRetentionOverride(ret.calculated_retention.toFixed(2));
      setStep(2);
    } catch (err) { alert(err.message); }
  }

  const RATE = 0.062;
  const effectiveRetention = parseFloat(retentionOverride) || 0;
  const mortgagePerPeriod = retention?.mortgage_per_period || 0;
  const totalToOffset = Math.max(0, parseFloat(netPay) - effectiveRetention);
  const trueSurplus = Math.max(0, totalToOffset - mortgagePerPeriod);
  const totalGoalAlloc = Object.values(goalAllocations).reduce((s, v) => s + (parseFloat(v) || 0), 0);
  const newOffsetBalance = (balances.offset || 0) + totalToOffset;
  const milestone = getMilestone(balances.offset || 0, newOffsetBalance);

  // Dynamic interest savings from THIS contribution
  const interestPeriods = useMemo(() => {
    const amt = totalToOffset;
    return [
      { label: '1 month', saved: amt * RATE / 12 },
      { label: '6 months', saved: calcInterestSaved(amt, RATE, 0.5) },
      { label: '1 year', saved: calcInterestSaved(amt, RATE, 1) },
      { label: '5 years', saved: calcInterestSaved(amt, RATE, 5) },
      { label: '10 years', saved: calcInterestSaved(amt, RATE, 10) },
      { label: '25 years', saved: calcInterestSaved(amt, RATE, 25) },
    ];
  }, [totalToOffset]);

  async function handleComplete() {
    try {
      const goalAllocs = Object.entries(goalAllocations)
        .filter(([_, amt]) => parseFloat(amt) > 0)
        .map(([goalId, amt]) => ({ goal_id: parseInt(goalId), amount: parseFloat(amt) }));

      await completePayDay({
        net_amount: parseFloat(netPay),
        gross_amount: parseFloat(grossPay) || parseFloat(netPay),
        pay_date: payDate,
        pay_type: payType,
        notes,
        retention_amount: effectiveRetention,
        mortgage_contribution: mortgagePerPeriod,
        offset_amount: totalToOffset,
        goal_allocations: goalAllocs
      });
      setSaved(true);
      getBalances().then(setBalances);
      getGoals().then(setGoals);
      getOffsetContributions().then(setContributions);
    } catch (err) { alert(err.message); }
  }

  async function handleAddUpcoming(e) {
    e.preventDefault();
    try {
      const entry = await addUpcomingExpense({
        ...upcomingForm,
        estimated_amount: parseFloat(upcomingForm.estimated_amount)
      });
      setUpcoming(prev => [...prev, entry]);
      setUpcomingForm({ description: '', estimated_amount: '', expected_date: '', category: '', notes: '' });
      setShowAddUpcoming(false);
    } catch (err) { alert(err.message); }
  }

  // Sweep mode handlers
  async function handleSweepAdvice() {
    setSweepLoading(true);
    try {
      const result = await getAccountSweepAdvice({ transaction_balance: parseFloat(txnBalance) });
      setSweepAdvice(result.advice);
      const match = result.advice.match(/(?:transfer|sweep|send|move)\s*\$?([\d,]+(?:\.\d{2})?)/i);
      if (match) setSweepAmount(match[1].replace(/,/g, ''));
      setStep(3);
    } catch (err) { alert(err.message); }
    setSweepLoading(false);
  }

  async function handleSweepConfirm() {
    try {
      await completePayDay({
        net_amount: parseFloat(sweepAmount),
        gross_amount: parseFloat(sweepAmount),
        pay_date: new Date().toISOString().split('T')[0],
        pay_type: 'sweep',
        notes: 'Account sweep to offset',
        retention_amount: parseFloat(txnBalance) - parseFloat(sweepAmount),
        mortgage_contribution: 0,
        offset_amount: parseFloat(sweepAmount),
        goal_allocations: []
      });
      setSaved(true);
      getBalances().then(setBalances);
    } catch (err) { alert(err.message); }
  }

  function handleModeSwitch(newMode) {
    setMode(newMode);
    setStep(1);
    setSweepAdvice(null);
    setSaved(false);
    setRetention(null);
  }

  const stepLabels = mode === 'payday'
    ? ['Record Pay', 'Retention & Surplus', 'Confirm & Allocate']
    : ['Enter Balance', 'Get Advice', 'Confirm Sweep'];

  // Contribution breakdown helpers
  const userColors = { 'Adam': '#6c5ce7', 'Aruto': '#00cec9' };

  return (
    <div>
      <div className="page-header">
        <h2>{mode === 'payday' ? 'Pay Day' : 'Offset Top-Up'}</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          {mode === 'payday' ? 'Record pay, retain what you need, send the rest to offset' : 'Sweep excess cash from transaction account to offset'}
        </p>
      </div>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }} role="tablist" aria-label="Pay day mode">
        <button className={`btn ${mode === 'payday' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => handleModeSwitch('payday')}
          role="tab" aria-selected={mode === 'payday'} aria-controls="payday-panel">
          <Wallet size={16} /> I Got Paid
        </button>
        <button className={`btn ${mode === 'sweep' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => handleModeSwitch('sweep')}
          role="tab" aria-selected={mode === 'sweep'} aria-controls="sweep-panel">
          <ArrowRightLeft size={16} /> Top Up Offset
        </button>
      </div>

      {/* Step indicator */}
      <nav className="payday-steps" aria-label="Pay day progress">
        {[1, 2, 3].map(s => (
          <div key={s} className={`payday-step ${step >= s ? 'active' : ''} ${step === s ? 'current' : ''}`}
            aria-current={step === s ? 'step' : undefined}>
            <div className="payday-step-circle" aria-hidden="true">
              {step > s ? <CheckCircle size={16} /> : s}
            </div>
            <span className="payday-step-label">{stepLabels[s - 1]}</span>
          </div>
        ))}
      </nav>

      {/* ==================== PAY DAY MODE ==================== */}

      {/* Step 1: Record Pay */}
      {mode === 'payday' && step === 1 && (
        <div className="card" role="form" aria-label="Record your pay">
          <div className="card-title"><Wallet size={18} /> Record Your Pay</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Hi {user?.display_name}! Pay cycle: <strong>{user?.pay_cycle}</strong>. Enter your actual net pay below.
          </p>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="net-pay">Net Pay Received ($)</label>
              <input id="net-pay" className="form-input" type="number" step="0.01" value={netPay}
                onChange={e => setNetPay(e.target.value)} placeholder="After tax amount"
                style={{ fontSize: '1.1rem', fontWeight: 600 }}
                aria-describedby="net-pay-hint" autoFocus />
              <span id="net-pay-hint" className="sr-only">Your take-home pay after tax and deductions</span>
            </div>
            <div className="form-group">
              <label htmlFor="gross-pay">Gross Pay ($)</label>
              <input id="gross-pay" className="form-input" type="number" step="0.01" value={grossPay}
                onChange={e => setGrossPay(e.target.value)} placeholder="Before tax" />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="pay-date">Pay Date</label>
              <input id="pay-date" className="form-input" type="date" value={payDate} onChange={e => setPayDate(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="pay-type">Pay Type</label>
              <select id="pay-type" className="form-select" value={payType} onChange={e => setPayType(e.target.value)}>
                <option value="regular">Regular Pay</option>
                <option value="overtime">Overtime</option>
                <option value="bonus">Bonus</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="pay-notes">Notes (optional)</label>
            <input id="pay-notes" className="form-input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Includes 5 hrs overtime" />
          </div>

          <button className="btn btn-primary" onClick={goToStep2} disabled={!netPay || parseFloat(netPay) <= 0}
            aria-label={`Continue to retention with ${fmtMoney(parseFloat(netPay) || 0)} net pay`}>
            Continue to Retention
          </button>
        </div>
      )}

      {/* Step 2: Retention & Surplus */}
      {mode === 'payday' && step === 2 && retention && (
        <div>
          {/* Retention calculator */}
          <div className="card" style={{ borderLeft: '4px solid var(--accent)' }}>
            <div className="card-title"><Shield size={18} /> Your Retention</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
              {retention.used_budget_floor
                ? <>Based on your monthly budget (more conservative than recent spending). Keeps enough for a full pay period of expenses.</>
                : <>Based on your last {retention.lookback_weeks} weeks of spending + {retention.profile?.buffer_percent || 10}% buffer.</>
              }
            </p>

            <div className="retention-hero">
              <div className="retention-breakdown" role="table" aria-label="Retention calculation">
                <div className="retention-row" role="row">
                  <span role="cell">Avg spend per {retention.pay_period === 'fortnightly' ? 'fortnight' : 'week'}</span>
                  <span role="cell">{fmtMoney(retention.avg_per_period)}</span>
                </div>
                <div className="retention-row" role="row">
                  <span role="cell">Buffer ({retention.profile?.buffer_percent || 10}%)</span>
                  <span role="cell">+{fmtMoney(retention.buffer_amount)}</span>
                </div>
                {retention.used_budget_floor && (
                  <div className="retention-row" role="row" style={{ color: 'var(--accent)', fontSize: '0.8rem' }}>
                    <span role="cell">Budget floor (per period)</span>
                    <span role="cell">{fmtMoney(retention.budget_per_period)}</span>
                  </div>
                )}
                {retention.upcoming_extra > 0 && (
                  <div className="retention-row" role="row">
                    <span role="cell">Upcoming expenses</span>
                    <span role="cell">+{fmtMoney(retention.upcoming_extra)}</span>
                  </div>
                )}
                <div className="retention-row total" role="row">
                  <span role="cell">Recommended retention</span>
                  <span role="cell">{fmtMoney(retention.calculated_retention)}</span>
                </div>
              </div>

              <div className="form-group" style={{ marginTop: '1rem' }}>
                <label htmlFor="retention-amount" style={{ fontWeight: 600 }}>Your retention amount (adjust if needed)</label>
                <input id="retention-amount" className="form-input" type="number" step="0.01" value={retentionOverride}
                  onChange={e => setRetentionOverride(e.target.value)}
                  style={{ maxWidth: 200, fontSize: '1.1rem', fontWeight: 700 }}
                  aria-describedby="retention-warning" />
                {parseFloat(retentionOverride) < retention.calculated_retention * 0.8 && (
                  <div id="retention-warning" role="alert" style={{ color: 'var(--red)', fontSize: '0.8rem', marginTop: 4 }}>
                    Below recommended — you may run short before next pay
                  </div>
                )}
              </div>
            </div>

            {/* Category breakdown toggle */}
            <button className="btn btn-ghost btn-sm" onClick={() => setShowBreakdown(!showBreakdown)} style={{ marginTop: '0.5rem' }}
              aria-expanded={showBreakdown} aria-controls="spending-breakdown">
              {showBreakdown ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {showBreakdown ? 'Hide' : 'Show'} spending breakdown
            </button>
            {showBreakdown && retention.by_category && (
              <div id="spending-breakdown" style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                {Object.entries(retention.by_category).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => (
                  <div key={cat} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                    <span>{cat}</span>
                    <span style={{ fontWeight: 600 }}>{fmtMoney(amt)}/period</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Transfer summary with mortgage line */}
          <div className="card offset-hero-card" style={{ marginTop: '1rem' }}>
            <div className="card-title"><TrendingUp size={18} /> Transfer Summary</div>
            <div className="retention-breakdown" role="table" aria-label="Transfer breakdown">
              <div className="retention-row" role="row">
                <span role="cell">Net pay</span>
                <span role="cell">{fmtMoney(parseFloat(netPay))}</span>
              </div>
              <div className="retention-row" role="row">
                <span role="cell">Retention (kept for expenses)</span>
                <span role="cell" style={{ color: 'var(--red)' }}>−{fmtMoney(effectiveRetention)}</span>
              </div>
              <div className="retention-row" role="row" style={{ borderBottom: '2px solid var(--border)' }}>
                <span role="cell" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Home size={14} aria-hidden="true" /> Mortgage contribution ({fmtMoney(retention?.mortgage_monthly || 0)}/mo)
                </span>
                <span role="cell" style={{ color: 'var(--yellow)' }}>−{fmtMoney(mortgagePerPeriod)}</span>
              </div>
              <div className="retention-row" role="row" style={{ fontWeight: 700, fontSize: '1.1rem' }}>
                <span role="cell" style={{ color: 'var(--green)' }}>True surplus to offset goals</span>
                <span role="cell" style={{ color: 'var(--green)' }}>{fmtMoney(trueSurplus)}</span>
              </div>
            </div>

            <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'rgba(0,206,201,0.08)', borderRadius: 8, fontSize: '0.85rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span>Mortgage portion → offset (reserved for 25th debit)</span>
                <span style={{ fontWeight: 600 }}>{fmtMoney(mortgagePerPeriod)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>True surplus → offset (available for goals)</span>
                <span style={{ fontWeight: 600, color: 'var(--green)' }}>{fmtMoney(trueSurplus)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, paddingTop: 4, borderTop: '1px solid var(--border)', fontWeight: 700 }}>
                <span>Total to offset account</span>
                <span style={{ color: 'var(--green)' }}>{fmtMoney(totalToOffset)}</span>
              </div>
            </div>

            {/* Offset balance before/after */}
            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginTop: '1rem' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Current offset</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{fmtK(balances.offset || 0)}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>After transfer</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--green)' }}>→ {fmtK(newOffsetBalance)}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Interest saved/mo</div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--green)' }}>~{fmtMoney(newOffsetBalance * RATE / 12)}/mo</div>
              </div>
            </div>
          </div>

          {/* ===== INTEREST SAVINGS FROM THIS CONTRIBUTION ===== */}
          {totalToOffset > 0 && (
            <div className="card" style={{ marginTop: '1rem', borderLeft: '4px solid var(--green)' }}>
              <div className="card-title"><Zap size={18} /> This Transfer Saves You</div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                By transferring {fmtMoney(totalToOffset)} to offset today at {(RATE * 100).toFixed(1)}%, you avoid paying this much interest:
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: '0.5rem' }}>
                {interestPeriods.map(p => (
                  <div key={p.label} className="interest-period-card" style={{
                    textAlign: 'center', padding: '0.6rem 0.4rem', background: 'var(--bg-input)', borderRadius: 8, border: '1px solid var(--border)'
                  }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{p.label}</div>
                    <div style={{ fontSize: p.saved >= 100 ? '1.1rem' : '1rem', fontWeight: 700, color: 'var(--green)' }}>{fmtMoneyShort(p.saved)}</div>
                  </div>
                ))}
              </div>
              {totalToOffset >= 500 && (
                <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--green)', textAlign: 'center', fontStyle: 'italic' }}>
                  Over the life of a 25-year mortgage, this single transfer saves you {fmtMoney(calcInterestSaved(totalToOffset, RATE, 25))} in interest
                </div>
              )}
            </div>
          )}

          {/* Milestone celebration */}
          {milestone && (
            <div role="alert" style={{
              marginTop: '0.75rem', padding: '1rem', background: 'linear-gradient(135deg, rgba(108,92,231,0.15), rgba(0,206,201,0.15))',
              borderRadius: 12, border: '2px solid var(--accent)', textAlign: 'center'
            }}>
              <Award size={28} style={{ color: 'var(--accent)', marginBottom: 4 }} />
              <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>Milestone: {fmtK(milestone)} in offset!</div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: 2 }}>
                This transfer takes you past {fmtK(milestone)}. That's saving ~{fmtMoney(milestone * RATE / 12)}/mo in interest.
              </div>
            </div>
          )}

          {/* Encouragement */}
          <div style={{ marginTop: '0.75rem', padding: '0.75rem 1rem', background: 'rgba(0,184,148,0.08)', borderRadius: 8, border: '1px solid rgba(0,184,148,0.2)', fontSize: '0.85rem', color: 'var(--green)' }}>
            Every dollar in offset saves you 6.2% in mortgage interest. Maximise your transfer — keep retention as low as you can comfortably manage.
          </div>

          {/* Upcoming expenses */}
          <div className="card" style={{ marginTop: '1rem' }}>
            <div className="card-title">Upcoming Expenses</div>
            {upcoming.length > 0 && (
              <div style={{ marginBottom: '0.75rem' }}>
                {upcoming.map(u => (
                  <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                    <div>
                      <span style={{ fontWeight: 600 }}>{u.description}</span>
                      <span style={{ marginLeft: 8, fontSize: '0.8rem', color: 'var(--text-muted)' }}>{u.expected_date}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontWeight: 600 }}>{fmtMoney(u.estimated_amount)}</span>
                      <button className="btn btn-ghost btn-sm" onClick={() => { resolveUpcomingExpense(u.id); setUpcoming(prev => prev.filter(x => x.id !== u.id)); }}
                        aria-label={`Remove ${u.description}`}>
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {showAddUpcoming ? (
              <form onSubmit={handleAddUpcoming} style={{ background: 'var(--bg-input)', padding: '0.75rem', borderRadius: 8 }}>
                <div className="form-row">
                  <div className="form-group"><input className="form-input" value={upcomingForm.description}
                    onChange={e => setUpcomingForm({ ...upcomingForm, description: e.target.value })} required placeholder="What's coming up?" /></div>
                  <div className="form-group"><input className="form-input" type="number" step="0.01" value={upcomingForm.estimated_amount}
                    onChange={e => setUpcomingForm({ ...upcomingForm, estimated_amount: e.target.value })} required placeholder="$ Amount" /></div>
                  <div className="form-group"><input className="form-input" type="date" value={upcomingForm.expected_date}
                    onChange={e => setUpcomingForm({ ...upcomingForm, expected_date: e.target.value })} required /></div>
                </div>
                <div className="btn-group">
                  <button className="btn btn-primary btn-sm" type="submit"><Plus size={14} /> Add</button>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowAddUpcoming(false)}>Cancel</button>
                </div>
              </form>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAddUpcoming(true)}>
                <Plus size={14} /> Add Upcoming Expense
              </button>
            )}
          </div>

          <div className="btn-group" style={{ marginTop: '1rem' }}>
            <button className="btn btn-primary" onClick={() => setStep(3)}>
              Continue to Confirm
            </button>
            <button className="btn btn-ghost" onClick={() => setStep(1)}>Back</button>
          </div>
        </div>
      )}

      {/* Step 3: Confirm & Allocate */}
      {mode === 'payday' && step === 3 && (
        <div>
          {/* Main confirmation card */}
          <div className="card offset-hero-card">
            <div className="card-title"><TrendingUp size={18} /> Transfer Summary</div>
            <div className="retention-breakdown" style={{ marginBottom: '1rem' }} role="table" aria-label="Final transfer breakdown">
              <div className="retention-row" role="row">
                <span role="cell">Net pay</span>
                <span role="cell">{fmtMoney(parseFloat(netPay))}</span>
              </div>
              <div className="retention-row" role="row">
                <span role="cell">Retention (kept for expenses)</span>
                <span role="cell">−{fmtMoney(effectiveRetention)}</span>
              </div>
              <div className="retention-row" role="row">
                <span role="cell"><Home size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} aria-hidden="true" />Mortgage contribution</span>
                <span role="cell">−{fmtMoney(mortgagePerPeriod)}</span>
              </div>
              <div className="retention-row" role="row" style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                <span role="cell" style={{ paddingLeft: '1.2rem' }}>↳ reserved in offset for 25th debit</span>
                <span role="cell"></span>
              </div>
              <div className="retention-row total" role="row" style={{ color: 'var(--green)' }}>
                <span role="cell">Total to offset account</span>
                <span role="cell">{fmtMoney(totalToOffset)}</span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
              <div className="stat-card" style={{ flex: 1, minWidth: 140 }}>
                <div className="stat-label">Offset Before</div>
                <div className="stat-value">{fmtK(balances.offset || 0)}</div>
              </div>
              <div className="stat-card" style={{ flex: 1, minWidth: 140, borderColor: 'var(--green)' }}>
                <div className="stat-label">Offset After</div>
                <div className="stat-value positive">{fmtK(newOffsetBalance)}</div>
              </div>
              <div className="stat-card" style={{ flex: 1, minWidth: 140 }}>
                <div className="stat-label">Interest Saved</div>
                <div className="stat-value positive">~{fmtMoney(newOffsetBalance * RATE / 12)}/mo</div>
              </div>
            </div>

            {/* True surplus breakdown */}
            <div style={{ padding: '0.75rem', background: 'rgba(0,206,201,0.08)', borderRadius: 8, fontSize: '0.85rem', marginBottom: '0.5rem' }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Of {fmtMoney(totalToOffset)} going to offset:</div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span><Home size={12} style={{ verticalAlign: 'middle' }} aria-hidden="true" /> Mortgage reserve</span>
                <span>{fmtMoney(mortgagePerPeriod)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--green)', fontWeight: 600 }}>
                <span>True surplus (available for goals)</span>
                <span>{fmtMoney(trueSurplus)}</span>
              </div>
            </div>
          </div>

          {/* ===== INTEREST SAVINGS BREAKDOWN (Step 3 compact) ===== */}
          {totalToOffset > 0 && (
            <div className="card" style={{ marginTop: '1rem', borderLeft: '4px solid var(--green)' }}>
              <div className="card-title"><Zap size={16} /> Interest Saved by This Transfer</div>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                {interestPeriods.slice(0, 4).map(p => (
                  <div key={p.label} style={{
                    flex: '1 1 80px', textAlign: 'center', padding: '0.5rem', background: 'var(--bg-input)', borderRadius: 8
                  }}>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{p.label}</div>
                    <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--green)' }}>{fmtMoneyShort(p.saved)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Milestone celebration */}
          {milestone && (
            <div role="alert" style={{
              marginTop: '0.75rem', padding: '1rem', background: 'linear-gradient(135deg, rgba(108,92,231,0.15), rgba(0,206,201,0.15))',
              borderRadius: 12, border: '2px solid var(--accent)', textAlign: 'center'
            }}>
              <Award size={28} style={{ color: 'var(--accent)', marginBottom: 4 }} />
              <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>You're crossing {fmtK(milestone)}!</div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: 2 }}>
                ~{fmtMoney(milestone * RATE / 12)}/mo in interest savings. Keep pushing!
              </div>
            </div>
          )}

          {/* Goal allocations — only from true surplus */}
          {goals.length > 0 && trueSurplus > 0 && (
            <div className="card" style={{ marginTop: '1rem' }}>
              <div className="card-title"><Target size={18} /> Earmark True Surplus for Goals</div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                Allocate from your {fmtMoney(trueSurplus)} true surplus. These are virtual buckets within offset — money stays earning interest.
              </p>

              {goals.map(g => {
                const pct = g.target_amount > 0 ? (g.current_amount / g.target_amount * 100) : 0;
                return (
                  <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{g.name}</div>
                      <div className="progress-bar" style={{ height: 6, marginTop: 4 }}>
                        <div className="progress-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        {fmtMoney(g.current_amount)} / {fmtMoney(g.target_amount)} ({pct.toFixed(0)}%)
                      </div>
                    </div>
                    <input className="form-input" type="number" step="0.01" style={{ width: 120 }}
                      value={goalAllocations[g.id] || ''}
                      onChange={e => setGoalAllocations(prev => ({ ...prev, [g.id]: e.target.value }))}
                      placeholder="$0.00" aria-label={`Allocate to ${g.name}`} />
                  </div>
                );
              })}

              {totalGoalAlloc > 0 && (
                <div role="status" style={{ fontSize: '0.85rem', color: totalGoalAlloc > trueSurplus ? 'var(--red)' : 'var(--text-muted)', marginTop: '0.5rem' }}>
                  Earmarking {fmtMoney(totalGoalAlloc)} of {fmtMoney(trueSurplus)} true surplus for goals.
                  {totalGoalAlloc > trueSurplus && ' Warning: exceeds true surplus!'}
                </div>
              )}
            </div>
          )}

          {/* Encouragement */}
          <div style={{ marginTop: '0.75rem', padding: '0.75rem 1rem', background: 'rgba(0,184,148,0.08)', borderRadius: 8, border: '1px solid rgba(0,184,148,0.2)', fontSize: '0.85rem', color: 'var(--green)' }}>
            Every dollar in offset saves you 6.2% in mortgage interest. The more you transfer, the faster you pay off the mortgage.
          </div>

          <div className="btn-group" style={{ marginTop: '1rem' }}>
            {saved ? (
              <div className="success-msg" role="alert" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '1rem', background: 'var(--green-bg)', borderRadius: 8 }}>
                <CheckCircle size={20} /> Pay recorded! {fmtMoney(totalToOffset)} sent to offset ({fmtMoney(mortgagePerPeriod)} mortgage reserve + {fmtMoney(trueSurplus)} surplus). Balances updated.
              </div>
            ) : (
              <>
                <button className="btn btn-success" onClick={handleComplete} disabled={totalToOffset <= 0}
                  aria-label={`Confirm sending ${fmtMoney(totalToOffset)} to offset account`}>
                  <CheckCircle size={16} /> Send {fmtMoney(totalToOffset)} to Offset
                </button>
                <button className="btn btn-ghost" onClick={() => setStep(2)}>Back</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ==================== SWEEP MODE ==================== */}

      {mode === 'sweep' && step === 1 && (
        <div className="card">
          <div className="card-title"><ArrowRightLeft size={18} /> Transaction Account Balance</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            How much is sitting in your transaction account? We'll figure out what's excess and can go to offset.
          </p>
          <div className="form-group">
            <label htmlFor="txn-balance">Transaction Account Balance ($)</label>
            <input id="txn-balance" className="form-input" type="number" step="0.01" value={txnBalance}
              onChange={e => setTxnBalance(e.target.value)} placeholder="e.g. 3500.00"
              style={{ maxWidth: 300, fontSize: '1.1rem' }} />
          </div>
          <button className="btn btn-primary" onClick={() => setStep(2)} disabled={!txnBalance || parseFloat(txnBalance) <= 0}>
            Analyse Balance
          </button>
        </div>
      )}

      {mode === 'sweep' && step === 2 && (
        <div className="card">
          <div className="card-title">Upcoming Expenses & Analysis</div>
          {upcoming.length > 0 && (
            <div style={{ marginBottom: '1rem' }}>
              {upcoming.map(u => (
                <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontWeight: 600 }}>{u.description} — {fmtMoney(u.estimated_amount)}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{u.expected_date}</span>
                </div>
              ))}
            </div>
          )}

          <div className="btn-group">
            <button className="btn btn-primary" onClick={handleSweepAdvice} disabled={sweepLoading}>
              {sweepLoading ? <><div className="spinner" /> Analysing...</> : 'Get Sweep Recommendation'}
            </button>
            <button className="btn btn-ghost" onClick={() => setStep(1)}>Back</button>
          </div>
        </div>
      )}

      {mode === 'sweep' && step === 3 && (
        <div>
          {sweepAdvice && (
            <div className="advice-box">
              <h3>Sweep Recommendation</h3>
              {sweepAdvice}
            </div>
          )}

          <div className="card offset-hero-card">
            <div className="card-title">Confirm Sweep to Offset</div>
            <div className="form-group" style={{ marginBottom: '1rem' }}>
              <label htmlFor="sweep-amount" style={{ fontWeight: 600 }}>Amount to transfer to offset ($)</label>
              <input id="sweep-amount" className="form-input" type="number" step="0.01" value={sweepAmount}
                onChange={e => setSweepAmount(e.target.value)}
                style={{ maxWidth: 200, fontSize: '1.1rem', fontWeight: 700 }} />
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
              {fmtMoney(parseFloat(txnBalance) - (parseFloat(sweepAmount) || 0))} stays in transaction account
            </div>

            <div className="btn-group">
              {saved ? (
                <div className="success-msg" role="alert" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <CheckCircle size={16} /> Swept {fmtMoney(parseFloat(sweepAmount))} to offset!
                </div>
              ) : (
                <>
                  <button className="btn btn-success" onClick={handleSweepConfirm} disabled={!sweepAmount || parseFloat(sweepAmount) <= 0}>
                    <CheckCircle size={16} /> Confirm Sweep
                  </button>
                  <button className="btn btn-ghost" onClick={() => { setStep(2); setSweepAdvice(null); }}>Back</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ==================== OFFSET BALANCE FOOTER ==================== */}
      <div className="card" style={{ marginTop: '1.5rem', background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)' }}>Offset Balance</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{fmtK(balances.offset || 0)}</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Interest Saved</div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--green)' }}>~{fmtMoney((balances.offset || 0) * RATE / 12)}/mo</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Mortgage Rate</div>
            <div style={{ fontSize: '1rem', fontWeight: 700 }}>{(RATE * 100).toFixed(1)}%</div>
          </div>
        </div>
      </div>

      {/* ==================== CONTRIBUTION BREAKDOWN (Adam vs Aruto) ==================== */}
      {contributions && contributions.per_user?.length > 1 && (
        <div className="card" style={{ marginTop: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showContributions ? '1rem' : 0 }}>
            <div className="card-title" style={{ margin: 0 }}><Users size={16} /> Offset Contributions</div>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowContributions(!showContributions)}
              aria-expanded={showContributions} aria-controls="contributions-panel">
              {showContributions ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {showContributions ? 'Hide' : 'Show'}
            </button>
          </div>

          {/* Always show the split bar */}
          <div style={{ marginTop: showContributions ? 0 : '0.75rem' }}>
            {/* Proportional bar */}
            <div style={{ display: 'flex', height: 28, borderRadius: 8, overflow: 'hidden', marginBottom: '0.5rem' }}
              role="img" aria-label={`Offset contribution split: ${contributions.per_user.map(u => `${u.display_name} ${u.share_pct}%`).join(', ')}`}>
              {contributions.per_user.map(u => (
                <div key={u.id} style={{
                  width: `${u.share_pct}%`, background: userColors[u.display_name] || 'var(--accent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.75rem', fontWeight: 700, color: '#fff', minWidth: u.share_pct > 5 ? 'auto' : 0
                }}>
                  {u.share_pct >= 15 && `${u.display_name} ${u.share_pct}%`}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
              {contributions.per_user.map(u => (
                <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: userColors[u.display_name] || 'var(--accent)', display: 'inline-block' }} />
                  <span style={{ fontWeight: 600 }}>{u.display_name}</span>
                  <span style={{ color: 'var(--green)' }}>{fmtK(u.total_offset)}</span>
                  <span style={{ color: 'var(--text-muted)' }}>({u.share_pct}%)</span>
                </div>
              ))}
            </div>
          </div>

          {showContributions && (
            <div id="contributions-panel" style={{ marginTop: '1rem' }}>
              {/* Per-user detail cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
                {contributions.per_user.map(u => (
                  <div key={u.id} style={{
                    background: 'var(--bg-input)', borderRadius: 8, padding: '0.75rem',
                    borderLeft: `4px solid ${userColors[u.display_name] || 'var(--accent)'}`
                  }}>
                    <div style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: '0.5rem' }}>{u.display_name}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.3rem', fontSize: '0.8rem' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Total to offset:</span>
                      <span style={{ fontWeight: 600, color: 'var(--green)' }}>{fmtMoney(u.total_offset)}</span>
                      <span style={{ color: 'var(--text-muted)' }}>Mortgage contrib:</span>
                      <span style={{ fontWeight: 600 }}>{fmtMoney(u.total_mortgage_contrib)}</span>
                      <span style={{ color: 'var(--text-muted)' }}>Total net income:</span>
                      <span style={{ fontWeight: 600 }}>{fmtMoney(u.total_net)}</span>
                      <span style={{ color: 'var(--text-muted)' }}>Avg offset/pay:</span>
                      <span style={{ fontWeight: 600, color: 'var(--green)' }}>{fmtMoney(u.avg_offset_per_pay)}</span>
                      <span style={{ color: 'var(--text-muted)' }}>Offset rate:</span>
                      <span style={{ fontWeight: 600 }}>{u.total_net > 0 ? Math.round(u.total_offset / u.total_net * 100) : 0}% of net</span>
                      <span style={{ color: 'var(--text-muted)' }}>Pay count:</span>
                      <span style={{ fontWeight: 600 }}>{u.pay_count} entries</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Monthly comparison table */}
              {contributions.monthly?.length > 0 && (() => {
                // Group monthly data by month
                const months = {};
                contributions.monthly.forEach(m => {
                  if (!months[m.month]) months[m.month] = {};
                  months[m.month][m.display_name] = { offset: parseFloat(m.offset_total) || 0, mortgage: parseFloat(m.mortgage_total) || 0 };
                });
                const monthKeys = Object.keys(months).sort();
                const users = contributions.per_user.map(u => u.display_name);

                return (
                  <div>
                    <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Monthly Offset Contributions</div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }} role="table">
                        <thead>
                          <tr style={{ borderBottom: '2px solid var(--border)' }}>
                            <th style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--text-muted)' }}>Month</th>
                            {users.map(name => (
                              <th key={name} style={{ textAlign: 'right', padding: '6px 8px', color: userColors[name] || 'var(--accent)' }}>{name}</th>
                            ))}
                            <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 700 }}>Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {monthKeys.map(month => {
                            const total = users.reduce((s, name) => s + (months[month][name]?.offset || 0), 0);
                            return (
                              <tr key={month} style={{ borderBottom: '1px solid var(--border)' }}>
                                <td style={{ padding: '6px 8px', fontWeight: 600 }}>{month}</td>
                                {users.map(name => (
                                  <td key={name} style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--green)' }}>
                                    {months[month][name] ? fmtMoneyShort(months[month][name].offset) : '-'}
                                  </td>
                                ))}
                                <td style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 700, color: 'var(--green)' }}>{fmtMoneyShort(total)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}

              {/* Grand total */}
              <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', background: 'rgba(0,206,201,0.08)', borderRadius: 8, display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: '0.9rem' }}>
                <span>Combined total to offset</span>
                <span style={{ color: 'var(--green)' }}>{fmtMoney(contributions.grand_total)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ==================== PAY HISTORY ==================== */}
      <div className="card" style={{ marginTop: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showHistory ? '1rem' : 0 }}>
          <div className="card-title" style={{ margin: 0 }}><Clock size={16} /> Pay History</div>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowHistory(!showHistory)}
            aria-expanded={showHistory} aria-controls="pay-history-panel">
            {showHistory ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {showHistory ? 'Hide' : `Show (${history.length})`}
          </button>
        </div>

        {showHistory && (
          <div id="pay-history-panel">
            {history.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No pay entries recorded yet.</p>
            ) : (
              <div className="pay-history-list">
                {history.map(h => {
                  const offsetAmt = h.offset_transfer || 0;
                  const retainAmt = h.retention_amount || 0;
                  const mortgageAmt = h.mortgage_contribution || 0;
                  const netAmt = h.net_amount || h.amount;
                  const hasGoals = h.goal_contributions && h.goal_contributions.length > 0;
                  const isExtra = offsetAmt > netAmt * 0.5;
                  return (
                    <div key={h.id} className={`pay-history-row ${isExtra ? 'pay-history-extra' : ''}`}>
                      <div className="pay-history-date">
                        <div className="pay-history-day">{new Date(h.pay_date + 'T12:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}</div>
                        <div className="pay-history-year">{h.pay_date.substring(0, 4)}</div>
                      </div>
                      <div className="pay-history-details">
                        <div className="pay-history-header">
                          <span className="pay-history-user">{h.user_name}</span>
                          <span className="pay-history-type">{h.pay_type}</span>
                          {h.notes && <span className="pay-history-notes">{h.notes}</span>}
                        </div>
                        <div className="pay-history-amounts">
                          <span className="pay-history-net">Net: <strong>{fmtMoney(netAmt)}</strong></span>
                          {offsetAmt > 0 && (
                            <span className="pay-history-offset">
                              → Offset: <strong style={{ color: '#00b894' }}>+{fmtMoney(offsetAmt)}</strong>
                              {isExtra && <span className="pay-history-bonus-badge">Extra!</span>}
                            </span>
                          )}
                          {retainAmt > 0 && (
                            <span className="pay-history-retain">Retained: {fmtMoney(retainAmt)}</span>
                          )}
                          {mortgageAmt > 0 && (
                            <span className="pay-history-retain" style={{ color: 'var(--yellow)' }}>Mortgage: {fmtMoney(mortgageAmt)}</span>
                          )}
                        </div>
                        {hasGoals && (
                          <div className="pay-history-goals">
                            {h.goal_contributions.map((gc, j) => (
                              <span key={j} className="payday-goal-chip">{gc.goal_name}: +{fmtMoney(gc.amount)}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Summary stats */}
            {history.length > 0 && (
              <div className="pay-history-summary">
                <div className="pay-history-summary-stat">
                  <span className="pay-history-summary-label">Total Pays</span>
                  <span className="pay-history-summary-value">{history.length}</span>
                </div>
                <div className="pay-history-summary-stat">
                  <span className="pay-history-summary-label">Total Net Income</span>
                  <span className="pay-history-summary-value">{fmtMoney(history.reduce((s, h) => s + (h.net_amount || h.amount || 0), 0))}</span>
                </div>
                <div className="pay-history-summary-stat">
                  <span className="pay-history-summary-label">Total to Offset</span>
                  <span className="pay-history-summary-value" style={{ color: '#00b894' }}>+{fmtMoney(history.reduce((s, h) => s + (h.offset_transfer || 0), 0))}</span>
                </div>
                <div className="pay-history-summary-stat">
                  <span className="pay-history-summary-label">Avg Offset/Pay</span>
                  <span className="pay-history-summary-value" style={{ color: '#00b894' }}>
                    {fmtMoney(history.reduce((s, h) => s + (h.offset_transfer || 0), 0) / history.length)}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
