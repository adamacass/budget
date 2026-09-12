import React, { useState, useEffect } from 'react';
import {
  getOffsetSummary, resetOffset, withdrawFromOffset, getOffsetWithdrawals,
  deleteOffsetWithdrawal, getOffsetLedger, getPlannedWithdrawals,
  addPlannedWithdrawal, deletePlannedWithdrawal,
} from '../api';
import {
  Wallet, ArrowDownCircle, ArrowUpCircle, RotateCcw, Trash2, Plus,
  AlertTriangle, CheckCircle, CalendarClock, History,
} from 'lucide-react';
import { getUserColor } from '../categoryColors';

function fmtMoney(n) {
  return '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtMoney2(n) {
  return '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '';
  const parts = String(d).split('-');
  if (parts.length !== 3) return d;
  return `${parseInt(parts[2])}/${parseInt(parts[1])}/${parts[0]}`;
}

const WITHDRAWAL_CATEGORIES = [
  'Home', 'Car', 'Travel', 'Tax', 'Emergency', 'Investment', 'Gift', 'Other',
];

const MOVEMENT_STYLE = {
  pay: { color: 'var(--green)', sign: '+' },
  deposit: { color: 'var(--green)', sign: '+' },
  withdrawal: { color: 'var(--red)', sign: '-' },
  mortgage: { color: 'var(--yellow)', sign: '-' },
  reset: { color: 'var(--blue)', sign: '=' },
  reversal: { color: 'var(--blue)', sign: '=' },
};

export default function Offset() {
  const [summary, setSummary] = useState(null);
  const [withdrawals, setWithdrawals] = useState([]);
  const [ledger, setLedger] = useState(null);
  const [planned, setPlanned] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Withdrawal form
  const [wAmount, setWAmount] = useState('');
  const [wDate, setWDate] = useState(new Date().toISOString().split('T')[0]);
  const [wReason, setWReason] = useState('');
  const [wCategory, setWCategory] = useState('Other');
  const [wGoal, setWGoal] = useState('');
  const [wIsDeposit, setWIsDeposit] = useState(false);

  // Reset form
  const [showReset, setShowReset] = useState(false);
  const [rBalance, setRBalance] = useState('');
  const [rNote, setRNote] = useState('');
  const [rRebalance, setRRebalance] = useState(true);

  // Planned withdrawal form
  const [pLabel, setPLabel] = useState('');
  const [pAmount, setPAmount] = useState('');
  const [pDate, setPDate] = useState('');
  const [pRecurring, setPRecurring] = useState(false);
  const [pFreq, setPFreq] = useState(12);

  function flash(text, isError) {
    if (isError) { setErr(text); setMsg(''); }
    else { setMsg(text); setErr(''); }
    setTimeout(() => { setMsg(''); setErr(''); }, 5000);
  }

  async function loadAll() {
    try {
      const [s, w, l, p] = await Promise.all([
        getOffsetSummary(), getOffsetWithdrawals(50), getOffsetLedger(180), getPlannedWithdrawals(),
      ]);
      setSummary(s);
      setWithdrawals(Array.isArray(w) ? w : []);
      setLedger(l);
      setPlanned(Array.isArray(p) ? p : []);
    } catch (e) {
      flash(e.message || 'Failed to load offset data', true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAll(); }, []);

  async function handleWithdraw(e) {
    e.preventDefault();
    const amt = parseFloat(String(wAmount).replace(/[$,]/g, ''));
    if (!amt || amt <= 0) { flash('Enter an amount greater than zero', true); return; }
    setBusy(true);
    try {
      const r = await withdrawFromOffset({
        amount: amt,
        withdrawal_date: wDate,
        reason: wReason || null,
        category: wCategory,
        goal_id: wGoal ? parseInt(wGoal) : null,
        deposit: wIsDeposit,
      });
      flash(`${wIsDeposit ? 'Deposit' : 'Withdrawal'} of ${fmtMoney2(amt)} recorded. Offset is now ${fmtMoney(r.balance)}.`);
      setWAmount(''); setWReason(''); setWGoal(''); setWCategory('Other'); setWIsDeposit(false);
      await loadAll();
    } catch (e) {
      flash(e.message || 'Could not record that', true);
    }
    setBusy(false);
  }

  async function handleReset(e) {
    e.preventDefault();
    const bal = parseFloat(String(rBalance).replace(/[$,]/g, ''));
    if (isNaN(bal) || bal < 0) { flash('Enter a valid balance', true); return; }
    setBusy(true);
    try {
      const r = await resetOffset({ balance: bal, note: rNote || null, rebalance_goals: rRebalance });
      const delta = r.change >= 0 ? `up ${fmtMoney2(r.change)}` : `down ${fmtMoney2(Math.abs(r.change))}`;
      flash(`Offset set to ${fmtMoney(r.balance)} (${delta}).${r.rebalanced ? ' Goal buckets were scaled to fit.' : ''}`);
      setShowReset(false); setRBalance(''); setRNote('');
      await loadAll();
    } catch (e) {
      flash(e.message || 'Could not reset the balance', true);
    }
    setBusy(false);
  }

  async function handleUndo(id) {
    if (!window.confirm('Reverse this withdrawal and add the money back to the offset?')) return;
    setBusy(true);
    try {
      const r = await deleteOffsetWithdrawal(id);
      flash(`Reversed. Offset is now ${fmtMoney(r.balance)}.`);
      await loadAll();
    } catch (e) {
      flash(e.message || 'Could not reverse that', true);
    }
    setBusy(false);
  }

  async function handleAddPlanned(e) {
    e.preventDefault();
    const amt = parseFloat(String(pAmount).replace(/[$,]/g, ''));
    if (!pLabel.trim() || !amt || amt <= 0) { flash('Give it a name and an amount', true); return; }
    if (!pRecurring && !pDate) { flash('Pick a date, or mark it recurring', true); return; }
    setBusy(true);
    try {
      await addPlannedWithdrawal({
        label: pLabel.trim(),
        amount: amt,
        target_date: pRecurring ? null : pDate,
        recurring: pRecurring,
        frequency_months: pRecurring ? parseInt(pFreq) || 12 : 0,
      });
      flash('Planned withdrawal added — projections now account for it.');
      setPLabel(''); setPAmount(''); setPDate(''); setPRecurring(false);
      await loadAll();
    } catch (e) {
      flash(e.message || 'Could not add that', true);
    }
    setBusy(false);
  }

  async function handleDeletePlanned(id) {
    setBusy(true);
    try {
      await deletePlannedWithdrawal(id);
      await loadAll();
    } catch (e) {
      flash(e.message || 'Could not remove that', true);
    }
    setBusy(false);
  }

  if (loading) {
    return <div className="loading-page"><div className="spinner" /> Loading offset...</div>;
  }

  const balance = summary?.balance || 0;
  const goals = summary?.goals || [];
  const unallocated = summary?.unallocated || 0;
  const overAllocated = summary?.over_allocated;
  const totals = ledger?.totals || {};
  const movements = ledger?.movements || [];

  return (
    <div>
      <div className="page-header">
        <h2>Offset Account</h2>
        <p>Track what's really in the offset — correct the balance, log withdrawals, and plan ahead</p>
      </div>

      {msg && (
        <div className="card" style={{ borderLeft: '3px solid var(--green)', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
          <CheckCircle size={16} style={{ color: 'var(--green)', flexShrink: 0 }} />
          <span style={{ fontSize: '0.85rem' }}>{msg}</span>
        </div>
      )}
      {err && (
        <div className="card" style={{ borderLeft: '3px solid var(--red)', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
          <AlertTriangle size={16} style={{ color: 'var(--red)', flexShrink: 0 }} />
          <span style={{ fontSize: '0.85rem' }}>{err}</span>
        </div>
      )}

      {/* ===== BALANCE ===== */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.25rem' }}>
              <Wallet size={14} /> Current balance
            </div>
            <div style={{ fontSize: '2.25rem', fontWeight: 700, lineHeight: 1.1, color: 'var(--text)' }}>
              {fmtMoney2(balance)}
            </div>
            {summary?.last_update && (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                Last change: {summary.last_update.note || summary.last_update.source}
                {summary.last_update.updated_at ? ` · ${new Date(summary.last_update.updated_at).toLocaleDateString('en-AU')}` : ''}
              </div>
            )}
          </div>
          <button className="btn btn-ghost" onClick={() => { setShowReset(v => !v); setRBalance(String(Math.round(balance * 100) / 100)); }}>
            <RotateCcw size={15} /> Correct balance
          </button>
        </div>

        {/* Bucket allocation */}
        <div style={{ marginTop: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.3rem' }}>
            <span>Allocated to goals: <strong style={{ color: 'var(--text)' }}>{fmtMoney(summary?.allocated_to_goals)}</strong></span>
            <span>Unallocated: <strong style={{ color: overAllocated ? 'var(--red)' : 'var(--text)' }}>{fmtMoney(unallocated)}</strong></span>
          </div>
          <div className="progress-bar" style={{ height: 10 }}>
            <div
              className={`progress-fill ${overAllocated ? 'red' : 'green'}`}
              style={{ width: `${balance > 0 ? Math.min(100, ((summary?.allocated_to_goals || 0) / balance) * 100) : 0}%` }}
            />
          </div>
          {overAllocated && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.5rem', fontSize: '0.78rem', color: 'var(--red)' }}>
              <AlertTriangle size={14} />
              Your goal buckets add up to more than the offset holds. Use "Correct balance" with rebalancing on to fix it.
            </div>
          )}
        </div>

        {/* Reset form */}
        {showReset && (
          <form onSubmit={handleReset} style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
              Set the offset to the figure your bank shows. This writes a new balance snapshot — history is kept.
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 150px' }}>
                <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Actual balance</label>
                <input className="form-input" type="text" inputMode="decimal" value={rBalance}
                  onChange={e => setRBalance(e.target.value)} placeholder="58236.51" />
              </div>
              <div style={{ flex: '2 1 220px' }}>
                <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Why (optional)</label>
                <input className="form-input" type="text" value={rNote}
                  onChange={e => setRNote(e.target.value)} placeholder="Reconciled with bank statement" />
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem', margin: '0.75rem 0' }}>
              <input type="checkbox" checked={rRebalance} onChange={e => setRRebalance(e.target.checked)} />
              Scale goal buckets down proportionally if they no longer fit
            </label>
            <div className="btn-group">
              <button className="btn btn-primary" type="submit" disabled={busy}>Save balance</button>
              <button className="btn btn-ghost" type="button" onClick={() => setShowReset(false)}>Cancel</button>
            </div>
          </form>
        )}
      </div>

      {/* ===== RECORD A MOVEMENT ===== */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="card-title">
          {wIsDeposit ? <ArrowUpCircle size={14} /> : <ArrowDownCircle size={14} />}
          {wIsDeposit ? ' Put money in' : ' Take money out'}
        </div>

        <div style={{ display: 'flex', gap: 2, background: 'var(--bg)', borderRadius: 6, padding: 2, width: 'fit-content', marginBottom: '0.75rem' }}>
          <button className={`btn btn-sm ${!wIsDeposit ? 'btn-primary' : 'btn-ghost'}`}
            style={{ padding: '3px 12px', fontSize: '0.75rem' }}
            onClick={() => setWIsDeposit(false)} type="button">Withdrawal</button>
          <button className={`btn btn-sm ${wIsDeposit ? 'btn-primary' : 'btn-ghost'}`}
            style={{ padding: '3px 12px', fontSize: '0.75rem' }}
            onClick={() => setWIsDeposit(true)} type="button">Deposit</button>
        </div>

        <form onSubmit={handleWithdraw}>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 120px' }}>
              <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Amount</label>
              <input className="form-input" type="text" inputMode="decimal" value={wAmount}
                onChange={e => setWAmount(e.target.value)} placeholder="5000" required />
            </div>
            <div style={{ flex: '1 1 130px' }}>
              <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Date</label>
              <input className="form-input" type="date" value={wDate} onChange={e => setWDate(e.target.value)} />
            </div>
            <div style={{ flex: '2 1 200px' }}>
              <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>What for</label>
              <input className="form-input" type="text" value={wReason}
                onChange={e => setWReason(e.target.value)} placeholder="Kitchen renovation deposit" />
            </div>
            <div style={{ flex: '1 1 130px' }}>
              <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Type</label>
              <select className="form-select" value={wCategory} onChange={e => setWCategory(e.target.value)}>
                {WITHDRAWAL_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div style={{ flex: '1 1 160px' }}>
              <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>
                {wIsDeposit ? 'Add to bucket' : 'Take from bucket'}
              </label>
              <select className="form-select" value={wGoal} onChange={e => setWGoal(e.target.value)}>
                <option value="">Unallocated</option>
                {goals.map(g => (
                  <option key={g.id} value={g.id}>{g.name} ({fmtMoney(g.current_amount)})</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ marginTop: '0.75rem' }}>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {wIsDeposit ? <ArrowUpCircle size={15} /> : <ArrowDownCircle size={15} />}
              {busy ? ' Saving...' : wIsDeposit ? ' Record deposit' : ' Record withdrawal'}
            </button>
          </div>
        </form>
      </div>

      {/* ===== LAST 6 MONTHS SUMMARY ===== */}
      <div className="stat-grid" style={{ marginBottom: '1rem' }}>
        <div className="stat-card">
          <div className="stat-label">Paid in (6mo)</div>
          <div className="stat-value positive">{fmtMoney(totals.in)}</div>
          <div className="card-sub">From pay transfers</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Paid out (6mo)</div>
          <div className="stat-value negative">{fmtMoney(totals.out)}</div>
          <div className="card-sub">Mortgage + withdrawals</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Withdrawn (6mo)</div>
          <div className="stat-value warning">{fmtMoney(totals.withdrawals)}</div>
          <div className="card-sub">Excluding mortgage</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Net change</div>
          <div className={`stat-value ${(totals.net || 0) >= 0 ? 'positive' : 'negative'}`}>
            {(totals.net || 0) >= 0 ? '+' : ''}{fmtMoney(totals.net)}
          </div>
          <div className="card-sub">Over 6 months</div>
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: '1rem' }}>
        {/* ===== WITHDRAWAL HISTORY ===== */}
        <div className="card">
          <div className="card-title"><History size={14} /> Recent withdrawals</div>
          {withdrawals.length === 0 ? (
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              Nothing recorded yet. Log one above whenever you pull money out, so projections stay honest.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Date</th><th>What</th><th>Amount</th><th></th></tr>
                </thead>
                <tbody>
                  {withdrawals.map(w => {
                    const isDeposit = w.amount < 0;
                    return (
                      <tr key={w.id}>
                        <td style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{fmtDate(w.withdrawal_date)}</td>
                        <td style={{ fontSize: '0.8rem' }}>
                          {w.reason || (isDeposit ? 'Deposit' : 'Withdrawal')}
                          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                            {w.category}{w.goal_name ? ` · ${w.goal_name}` : ''}
                            {w.user_name ? <span style={{ color: getUserColor(w.user_name) }}> · {w.user_name}</span> : null}
                          </div>
                        </td>
                        <td style={{ fontWeight: 600, whiteSpace: 'nowrap', color: isDeposit ? 'var(--green)' : 'var(--red)' }}>
                          {isDeposit ? '+' : '-'}{fmtMoney2(Math.abs(w.amount))}
                        </td>
                        <td>
                          <button className="btn btn-ghost btn-sm" title="Reverse" disabled={busy}
                            onClick={() => handleUndo(w.id)}>
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ===== PLANNED WITHDRAWALS ===== */}
        <div className="card">
          <div className="card-title"><CalendarClock size={14} /> Planned withdrawals</div>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            Money you know is coming out. Projections subtract these, so the offset forecast stays realistic.
          </p>

          <form onSubmit={handleAddPlanned} style={{ marginBottom: '0.75rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <input className="form-input" style={{ flex: '2 1 140px' }} value={pLabel}
                onChange={e => setPLabel(e.target.value)} placeholder="What for (e.g. Car)" />
              <input className="form-input" style={{ flex: '1 1 90px' }} type="text" inputMode="decimal"
                value={pAmount} onChange={e => setPAmount(e.target.value)} placeholder="Amount" />
              {!pRecurring ? (
                <input className="form-input" style={{ flex: '1 1 130px' }} type="date"
                  value={pDate} onChange={e => setPDate(e.target.value)} />
              ) : (
                <select className="form-select" style={{ flex: '1 1 130px' }} value={pFreq}
                  onChange={e => setPFreq(e.target.value)}>
                  <option value={1}>Every month</option>
                  <option value={3}>Every 3 months</option>
                  <option value={6}>Every 6 months</option>
                  <option value={12}>Every year</option>
                </select>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.76rem' }}>
                <input type="checkbox" checked={pRecurring} onChange={e => setPRecurring(e.target.checked)} />
                Recurring
              </label>
              <button className="btn btn-ghost btn-sm" type="submit" disabled={busy}>
                <Plus size={13} /> Add
              </button>
            </div>
          </form>

          {planned.length === 0 ? (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Nothing planned.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {planned.map(p => (
                <div key={p.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  gap: '0.5rem', padding: '0.45rem 0.6rem', background: 'var(--bg)', borderRadius: 6,
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 500 }}>{p.label}</div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                      {p.recurring
                        ? `Every ${p.frequency_months} month${p.frequency_months === 1 ? '' : 's'}`
                        : fmtDate(p.target_date)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span style={{ fontWeight: 600, color: 'var(--red)', whiteSpace: 'nowrap' }}>-{fmtMoney(p.amount)}</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => handleDeletePlanned(p.id)} disabled={busy}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ===== MOVEMENT LEDGER ===== */}
      <div className="card">
        <div className="card-title"><History size={14} /> All movements (6 months)</div>
        {movements.length === 0 ? (
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>No movements recorded in this period.</p>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr><th>Date</th><th>Movement</th><th style={{ textAlign: 'right' }}>Amount</th></tr>
              </thead>
              <tbody>
                {movements.map((m, i) => {
                  const style = MOVEMENT_STYLE[m.type] || { color: 'var(--text-muted)', sign: '' };
                  return (
                    <tr key={i}>
                      <td style={{ fontSize: '0.76rem', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{fmtDate(m.date)}</td>
                      <td style={{ fontSize: '0.8rem' }}>{m.label}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap', color: style.color }}>
                        {m.direction === 'adjust' ? `= ${fmtMoney(m.amount)}` : `${style.sign}${fmtMoney(m.amount)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
