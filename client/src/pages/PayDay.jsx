import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { addIncome, getBalances, getRetention, getPayDayAdvice, getAccountSweepAdvice, getUpcomingExpenses, addUpcomingExpense, resolveUpcomingExpense, completePayDay, getGoals } from '../api';
import { Wallet, CheckCircle, Plus, X, ArrowRightLeft, TrendingUp, Shield, Target, ChevronDown, ChevronUp, Info } from 'lucide-react';

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtK(n) { return n >= 1000 ? '$' + (n / 1000).toFixed(0) + 'k' : fmtMoney(n); }

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
  const [advice, setAdvice] = useState(null);
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [upcoming, setUpcoming] = useState([]);
  const [showAddUpcoming, setShowAddUpcoming] = useState(false);
  const [upcomingForm, setUpcomingForm] = useState({ description: '', estimated_amount: '', expected_date: '', category: '', notes: '' });
  const [goals, setGoals] = useState([]);
  const [goalAllocations, setGoalAllocations] = useState({});
  const [saved, setSaved] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);
  // Sweep mode
  const [txnBalance, setTxnBalance] = useState('');
  const [sweepAmount, setSweepAmount] = useState('');

  useEffect(() => {
    getBalances().then(setBalances).catch(console.error);
    getUpcomingExpenses().then(setUpcoming).catch(console.error);
    getGoals().then(setGoals).catch(console.error);
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

  const effectiveRetention = parseFloat(retentionOverride) || 0;
  const surplus = Math.max(0, parseFloat(netPay) - effectiveRetention);
  const totalGoalAlloc = Object.values(goalAllocations).reduce((s, v) => s + (parseFloat(v) || 0), 0);

  async function handleGetAdvice() {
    setAdviceLoading(true);
    try {
      const result = await getPayDayAdvice({
        net_pay: parseFloat(netPay),
        retention_data: retention
      });
      setAdvice(result.advice);
    } catch (err) { console.error(err); }
    setAdviceLoading(false);
  }

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
        offset_amount: surplus,
        goal_allocations: goalAllocs
      });
      setSaved(true);
      getBalances().then(setBalances);
      getGoals().then(setGoals);
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
    setAdviceLoading(true);
    try {
      const result = await getAccountSweepAdvice({ transaction_balance: parseFloat(txnBalance) });
      setAdvice(result.advice);
      // Extract suggested amount
      const match = result.advice.match(/(?:transfer|sweep|send|move)\s*\$?([\d,]+(?:\.\d{2})?)/i);
      if (match) setSweepAmount(match[1].replace(/,/g, ''));
      setStep(3);
    } catch (err) { alert(err.message); }
    setAdviceLoading(false);
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
    setAdvice(null);
    setSaved(false);
    setRetention(null);
  }

  const stepLabels = mode === 'payday'
    ? ['Record Pay', 'Retention & Surplus', 'Confirm & Allocate']
    : ['Enter Balance', 'Get Advice', 'Confirm Sweep'];

  return (
    <div>
      <div className="page-header">
        <h2>{mode === 'payday' ? 'Pay Day' : 'Offset Top-Up'}</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          {mode === 'payday' ? 'Record pay, retain what you need, send the rest to offset' : 'Sweep excess cash from transaction account to offset'}
        </p>
      </div>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <button className={`btn ${mode === 'payday' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => handleModeSwitch('payday')}>
          <Wallet size={16} /> I Got Paid
        </button>
        <button className={`btn ${mode === 'sweep' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => handleModeSwitch('sweep')}>
          <ArrowRightLeft size={16} /> Top Up Offset
        </button>
      </div>

      {/* Step indicator */}
      <div className="payday-steps">
        {[1, 2, 3].map(s => (
          <div key={s} className={`payday-step ${step >= s ? 'active' : ''} ${step === s ? 'current' : ''}`}>
            <div className="payday-step-circle">
              {step > s ? <CheckCircle size={16} /> : s}
            </div>
            <span className="payday-step-label">{stepLabels[s - 1]}</span>
          </div>
        ))}
      </div>

      {/* ==================== PAY DAY MODE ==================== */}

      {/* Step 1: Record Pay */}
      {mode === 'payday' && step === 1 && (
        <div className="card">
          <div className="card-title"><Wallet size={18} /> Record Your Pay</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Hi {user?.display_name}! Pay cycle: <strong>{user?.pay_cycle}</strong>. Enter your actual net pay below.
          </p>

          <div className="form-row">
            <div className="form-group">
              <label>Net Pay Received ($)</label>
              <input className="form-input" type="number" step="0.01" value={netPay}
                onChange={e => setNetPay(e.target.value)} placeholder="After tax amount"
                style={{ fontSize: '1.1rem', fontWeight: 600 }} />
            </div>
            <div className="form-group">
              <label>Gross Pay ($)</label>
              <input className="form-input" type="number" step="0.01" value={grossPay}
                onChange={e => setGrossPay(e.target.value)} placeholder="Before tax" />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Pay Date</label>
              <input className="form-input" type="date" value={payDate} onChange={e => setPayDate(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Pay Type</label>
              <select className="form-select" value={payType} onChange={e => setPayType(e.target.value)}>
                <option value="regular">Regular Pay</option>
                <option value="overtime">Overtime</option>
                <option value="bonus">Bonus</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>Notes (optional)</label>
            <input className="form-input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Includes 5 hrs overtime" />
          </div>

          <button className="btn btn-primary" onClick={goToStep2} disabled={!netPay || parseFloat(netPay) <= 0}>
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
              Based on your last {retention.lookback_weeks} weeks of spending, here's how much to keep for expenses.
            </p>

            <div className="retention-hero">
              <div className="retention-breakdown">
                <div className="retention-row">
                  <span>Avg spend per {retention.pay_period === 'fortnightly' ? 'fortnight' : 'week'}</span>
                  <span>{fmtMoney(retention.avg_per_period)}</span>
                </div>
                <div className="retention-row">
                  <span>Buffer ({retention.profile?.buffer_percent || 10}%)</span>
                  <span>+{fmtMoney(retention.buffer_amount)}</span>
                </div>
                {retention.upcoming_extra > 0 && (
                  <div className="retention-row">
                    <span>Upcoming expenses</span>
                    <span>+{fmtMoney(retention.upcoming_extra)}</span>
                  </div>
                )}
                <div className="retention-row total">
                  <span>Recommended retention</span>
                  <span>{fmtMoney(retention.calculated_retention)}</span>
                </div>
              </div>

              <div className="form-group" style={{ marginTop: '1rem' }}>
                <label style={{ fontWeight: 600 }}>Your retention amount (adjust if needed)</label>
                <input className="form-input" type="number" step="0.01" value={retentionOverride}
                  onChange={e => setRetentionOverride(e.target.value)}
                  style={{ maxWidth: 200, fontSize: '1.1rem', fontWeight: 700 }} />
                {parseFloat(retentionOverride) < retention.calculated_retention * 0.8 && (
                  <div style={{ color: 'var(--red)', fontSize: '0.8rem', marginTop: 4 }}>
                    Below recommended — you may run short before next pay
                  </div>
                )}
              </div>
            </div>

            {/* Category breakdown toggle */}
            <button className="btn btn-ghost btn-sm" onClick={() => setShowBreakdown(!showBreakdown)} style={{ marginTop: '0.5rem' }}>
              {showBreakdown ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {showBreakdown ? 'Hide' : 'Show'} spending breakdown
            </button>
            {showBreakdown && retention.by_category && (
              <div style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                {Object.entries(retention.by_category).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => (
                  <div key={cat} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                    <span>{cat}</span>
                    <span style={{ fontWeight: 600 }}>{fmtMoney(amt)}/period</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Surplus display */}
          <div className="card offset-hero-card" style={{ marginTop: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <div style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', marginBottom: 4 }}>Surplus to Offset</div>
                <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--green)' }}>{fmtMoney(surplus)}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {fmtMoney(parseFloat(netPay))} pay − {fmtMoney(effectiveRetention)} retention
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Current offset</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{fmtK(balances.offset || 0)}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--green)' }}>→ {fmtK((balances.offset || 0) + surplus)} after</div>
              </div>
            </div>
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
                      <button className="btn btn-ghost btn-sm" onClick={() => { resolveUpcomingExpense(u.id); setUpcoming(prev => prev.filter(x => x.id !== u.id)); }}>
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
            <button className="btn btn-primary" onClick={() => { handleGetAdvice(); setStep(3); }}>
              Continue to Confirm
            </button>
            <button className="btn btn-ghost" onClick={() => setStep(1)}>Back</button>
          </div>
        </div>
      )}

      {/* Step 3: Confirm & Allocate */}
      {mode === 'payday' && step === 3 && (
        <div>
          {/* Claude advice */}
          {adviceLoading && (
            <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
              <div className="spinner" style={{ marginBottom: '0.5rem' }} />
              <span style={{ color: 'var(--text-muted)' }}>Getting Claude's advice...</span>
            </div>
          )}
          {advice && (
            <div className="advice-box">
              <h3>Claude's Advice</h3>
              {advice}
            </div>
          )}

          {/* Main confirmation card */}
          <div className="card offset-hero-card">
            <div className="card-title"><TrendingUp size={18} /> Transfer Summary</div>
            <div className="retention-breakdown" style={{ marginBottom: '1rem' }}>
              <div className="retention-row">
                <span>Net pay</span>
                <span>{fmtMoney(parseFloat(netPay))}</span>
              </div>
              <div className="retention-row">
                <span>Retention (kept for expenses)</span>
                <span>−{fmtMoney(effectiveRetention)}</span>
              </div>
              <div className="retention-row total" style={{ color: 'var(--green)' }}>
                <span>To offset account</span>
                <span>{fmtMoney(surplus)}</span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
              <div className="stat-card" style={{ flex: 1, minWidth: 140 }}>
                <div className="stat-label">Offset Before</div>
                <div className="stat-value">{fmtK(balances.offset || 0)}</div>
              </div>
              <div className="stat-card" style={{ flex: 1, minWidth: 140, borderColor: 'var(--green)' }}>
                <div className="stat-label">Offset After</div>
                <div className="stat-value positive">{fmtK((balances.offset || 0) + surplus)}</div>
              </div>
              <div className="stat-card" style={{ flex: 1, minWidth: 140 }}>
                <div className="stat-label">Interest Saved</div>
                <div className="stat-value positive">~{fmtMoney(((balances.offset || 0) + surplus) * 0.062 / 12)}/mo</div>
              </div>
            </div>
          </div>

          {/* Goal allocations */}
          {goals.length > 0 && (
            <div className="card" style={{ marginTop: '1rem' }}>
              <div className="card-title"><Target size={18} /> Earmark for Goals (optional)</div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                These are virtual buckets within your offset — the money stays in offset earning interest, but is earmarked for specific goals.
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
                      placeholder="$0.00" />
                  </div>
                );
              })}

              {totalGoalAlloc > 0 && (
                <div style={{ fontSize: '0.85rem', color: totalGoalAlloc > surplus ? 'var(--red)' : 'var(--text-muted)', marginTop: '0.5rem' }}>
                  Earmarking {fmtMoney(totalGoalAlloc)} of {fmtMoney(surplus)} surplus for goals.
                  {totalGoalAlloc > surplus && ' Warning: exceeds surplus!'}
                </div>
              )}
            </div>
          )}

          <div className="btn-group" style={{ marginTop: '1rem' }}>
            {saved ? (
              <div className="success-msg" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '1rem', background: 'var(--green-bg)', borderRadius: 8 }}>
                <CheckCircle size={20} /> Pay recorded! {fmtMoney(surplus)} sent to offset. Balances updated.
              </div>
            ) : (
              <>
                <button className="btn btn-success" onClick={handleComplete} disabled={surplus <= 0}>
                  <CheckCircle size={16} /> Send {fmtMoney(surplus)} to Offset
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
            <label>Transaction Account Balance ($)</label>
            <input className="form-input" type="number" step="0.01" value={txnBalance}
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
            <button className="btn btn-primary" onClick={handleSweepAdvice} disabled={adviceLoading}>
              {adviceLoading ? <><div className="spinner" /> Analysing...</> : 'Get Sweep Recommendation'}
            </button>
            <button className="btn btn-ghost" onClick={() => setStep(1)}>Back</button>
          </div>
        </div>
      )}

      {mode === 'sweep' && step === 3 && (
        <div>
          {advice && (
            <div className="advice-box">
              <h3>Claude's Recommendation</h3>
              {advice}
            </div>
          )}

          <div className="card offset-hero-card">
            <div className="card-title">Confirm Sweep to Offset</div>
            <div className="form-group" style={{ marginBottom: '1rem' }}>
              <label style={{ fontWeight: 600 }}>Amount to transfer to offset ($)</label>
              <input className="form-input" type="number" step="0.01" value={sweepAmount}
                onChange={e => setSweepAmount(e.target.value)}
                style={{ maxWidth: 200, fontSize: '1.1rem', fontWeight: 700 }} />
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
              {fmtMoney(parseFloat(txnBalance) - (parseFloat(sweepAmount) || 0))} stays in transaction account
            </div>

            <div className="btn-group">
              {saved ? (
                <div className="success-msg" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <CheckCircle size={16} /> Swept {fmtMoney(parseFloat(sweepAmount))} to offset!
                </div>
              ) : (
                <>
                  <button className="btn btn-success" onClick={handleSweepConfirm} disabled={!sweepAmount || parseFloat(sweepAmount) <= 0}>
                    <CheckCircle size={16} /> Confirm Sweep
                  </button>
                  <button className="btn btn-ghost" onClick={() => { setStep(2); setAdvice(null); }}>Back</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Current offset balance footer */}
      <div className="card" style={{ marginTop: '1.5rem', background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)' }}>Offset Balance</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{fmtK(balances.offset || 0)}</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Interest Saved</div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--green)' }}>~{fmtMoney((balances.offset || 0) * 0.062 / 12)}/mo</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Mortgage Rate</div>
            <div style={{ fontSize: '1rem', fontWeight: 700 }}>6.20%</div>
          </div>
        </div>
      </div>
    </div>
  );
}
