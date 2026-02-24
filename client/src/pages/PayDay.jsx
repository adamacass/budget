import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { addIncome, getBalances, getPayDayAdvice, getUpcomingExpenses, addUpcomingExpense, resolveUpcomingExpense, addAllocations } from '../api';
import { Wallet, AlertTriangle, CheckCircle, Plus, X } from 'lucide-react';

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export default function PayDay() {
  const { user } = useAuth();
  const [step, setStep] = useState(1);
  const [netPay, setNetPay] = useState('');
  const [grossPay, setGrossPay] = useState('');
  const [payDate, setPayDate] = useState(new Date().toISOString().split('T')[0]);
  const [payType, setPayType] = useState('regular');
  const [notes, setNotes] = useState('');
  const [balances, setBalances] = useState({});
  const [advice, setAdvice] = useState(null);
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [upcoming, setUpcoming] = useState([]);
  const [showAddUpcoming, setShowAddUpcoming] = useState(false);
  const [upcomingForm, setUpcomingForm] = useState({ description: '', estimated_amount: '', expected_date: '', category: '', notes: '' });
  const [allocations, setAllocations] = useState([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getBalances().then(setBalances).catch(console.error);
    getUpcomingExpenses().then(setUpcoming).catch(console.error);
  }, []);

  // Estimate net pay from gross
  useEffect(() => {
    if (user && !netPay && user.gross_income) {
      const grossExSuper = user.gross_income / (1 + (user.super_rate || 0.115));
      let periods = user.pay_cycle === 'weekly' ? 52 : user.pay_cycle === 'fortnightly' ? 26 : 12;
      const grossPerPeriod = grossExSuper / periods;
      // Rough tax + HECS estimate
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

  async function handleRecordPay() {
    try {
      await addIncome({
        amount: parseFloat(grossPay) || parseFloat(netPay),
        net_amount: parseFloat(netPay),
        pay_date: payDate,
        pay_type: payType,
        notes
      });
      setStep(2);
    } catch (err) { alert(err.message); }
  }

  async function handleGetAdvice() {
    setAdviceLoading(true);
    try {
      const result = await getPayDayAdvice({
        net_pay: parseFloat(netPay),
        upcoming_expenses_override: upcoming
      });
      setAdvice(result.advice);
      // Parse suggested allocations from advice (simple extraction)
      const lines = result.advice.split('\n');
      const allocs = [];
      const accounts = ['offset', 'savings', 'credit_card', 'investment'];
      for (const line of lines) {
        for (const acct of accounts) {
          const regex = new RegExp(`\\$([\\d,]+(?:\\.\\d{2})?).*${acct.replace('_', '[\\s_]')}|${acct.replace('_', '[\\s_]')}.*\\$([\\d,]+(?:\\.\\d{2})?)`, 'i');
          const match = line.match(regex);
          if (match) {
            const amt = parseFloat((match[1] || match[2]).replace(/,/g, ''));
            if (amt > 0 && !allocs.find(a => a.target_account === acct)) {
              allocs.push({ target_account: acct, amount: amt, notes: 'AI suggested' });
            }
          }
        }
      }
      if (allocs.length > 0) setAllocations(allocs);
      setStep(3);
    } catch (err) { alert(err.message); }
    setAdviceLoading(false);
  }

  async function handleSaveAllocations() {
    try {
      await addAllocations({ allocations: allocations.map(a => ({ ...a, allocated_date: payDate })) });
      setSaved(true);
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

  async function handleResolveUpcoming(id) {
    await resolveUpcomingExpense(id);
    setUpcoming(prev => prev.filter(u => u.id !== id));
  }

  return (
    <div>
      <div className="page-header">
        <h2>Pay Day</h2>
        <p>Record your pay and get AI-powered allocation guidance</p>
      </div>

      {/* Step indicator */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem' }}>
        {[1, 2, 3].map(s => (
          <div key={s} style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            color: step >= s ? 'var(--accent)' : 'var(--text-muted)',
            fontWeight: step === s ? 700 : 400, fontSize: '0.85rem'
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: step > s ? 'var(--green)' : step === s ? 'var(--accent)' : 'var(--bg-input)',
              color: step >= s ? '#fff' : 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 700
            }}>
              {step > s ? <CheckCircle size={16} /> : s}
            </div>
            {s === 1 ? 'Record Pay' : s === 2 ? 'Review & Foreshadow' : 'Allocate Funds'}
          </div>
        ))}
      </div>

      {/* Step 1: Record Pay */}
      {step === 1 && (
        <div className="card">
          <div className="card-title">I Just Got Paid!</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Hi {user?.display_name}! Your pay cycle: <strong>{user?.pay_cycle}</strong>.
            Enter your actual pay below (pre-filled with estimate).
          </p>

          <div className="form-row">
            <div className="form-group">
              <label>Net Pay Received ($)</label>
              <input className="form-input" type="number" step="0.01" value={netPay}
                onChange={e => setNetPay(e.target.value)} placeholder="After tax amount" />
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

          <button className="btn btn-primary" onClick={handleRecordPay} disabled={!netPay}>
            <Wallet size={16} /> Record Pay & Continue
          </button>
        </div>
      )}

      {/* Step 2: Upcoming/Bulge Expenses */}
      {step === 2 && (
        <div className="card">
          <div className="card-title">Upcoming Bulge Expenses</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Foreshadow any large or unusual expenses coming up so Claude can factor them into your allocation plan.
          </p>

          {upcoming.length > 0 && (
            <div className="table-wrap" style={{ marginBottom: '1rem' }}>
              <table>
                <thead>
                  <tr><th>Description</th><th>Amount</th><th>Expected</th><th>Category</th><th>Notes</th><th></th></tr>
                </thead>
                <tbody>
                  {upcoming.map(u => (
                    <tr key={u.id}>
                      <td style={{ fontWeight: 600 }}>{u.description}</td>
                      <td>{fmtMoney(u.estimated_amount)}</td>
                      <td>{u.expected_date}</td>
                      <td><span className="tag tag-yellow">{u.category || '-'}</span></td>
                      <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{u.notes || '-'}</td>
                      <td>
                        <button className="btn btn-ghost btn-sm" onClick={() => handleResolveUpcoming(u.id)} title="Mark resolved">
                          <CheckCircle size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {showAddUpcoming ? (
            <form onSubmit={handleAddUpcoming} style={{ background: 'var(--bg-input)', padding: '1rem', borderRadius: 8, marginBottom: '1rem' }}>
              <div className="form-row">
                <div className="form-group">
                  <label>What's coming up?</label>
                  <input className="form-input" value={upcomingForm.description}
                    onChange={e => setUpcomingForm({ ...upcomingForm, description: e.target.value })} required placeholder="e.g. Car rego, dental work" />
                </div>
                <div className="form-group">
                  <label>Estimated Cost ($)</label>
                  <input className="form-input" type="number" step="0.01" value={upcomingForm.estimated_amount}
                    onChange={e => setUpcomingForm({ ...upcomingForm, estimated_amount: e.target.value })} required />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Expected Date</label>
                  <input className="form-input" type="date" value={upcomingForm.expected_date}
                    onChange={e => setUpcomingForm({ ...upcomingForm, expected_date: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label>Category</label>
                  <input className="form-input" value={upcomingForm.category}
                    onChange={e => setUpcomingForm({ ...upcomingForm, category: e.target.value })} placeholder="e.g. Car, Medical" />
                </div>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <input className="form-input" value={upcomingForm.notes}
                  onChange={e => setUpcomingForm({ ...upcomingForm, notes: e.target.value })} placeholder="Any extra context for Claude" />
              </div>
              <div className="btn-group">
                <button className="btn btn-primary" type="submit"><Plus size={14} /> Add</button>
                <button className="btn btn-ghost" type="button" onClick={() => setShowAddUpcoming(false)}><X size={14} /> Cancel</button>
              </div>
            </form>
          ) : (
            <button className="btn btn-ghost" onClick={() => setShowAddUpcoming(true)} style={{ marginBottom: '1rem' }}>
              <Plus size={14} /> Add Upcoming Expense
            </button>
          )}

          <div className="btn-group">
            <button className="btn btn-primary" onClick={handleGetAdvice} disabled={adviceLoading}>
              {adviceLoading ? <><div className="spinner" /> Getting Claude's advice...</> : 'Get Claude Allocation Advice'}
            </button>
            <button className="btn btn-ghost" onClick={() => setStep(1)}>Back</button>
          </div>
        </div>
      )}

      {/* Step 3: Claude Advice + Allocations */}
      {step === 3 && (
        <div>
          {advice && (
            <div className="advice-box">
              <h3>Claude's Allocation Advice</h3>
              {advice}
            </div>
          )}

          <div className="card">
            <div className="card-title">Fund Allocations</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
              Confirm or adjust the allocations below. Total pay: <strong>{fmtMoney(parseFloat(netPay))}</strong>
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {['offset', 'savings', 'credit_card', 'investment'].map(acct => {
                const existing = allocations.find(a => a.target_account === acct);
                return (
                  <div key={acct} style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <div style={{ width: 140, fontWeight: 600, fontSize: '0.85rem', textTransform: 'capitalize' }}>
                      {acct.replace('_', ' ')}
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', width: 120 }}>
                      Current: {fmtMoney(balances[acct])}
                    </div>
                    <input className="form-input" type="number" step="0.01" style={{ width: 150 }}
                      value={existing?.amount || ''}
                      onChange={e => {
                        const val = parseFloat(e.target.value) || 0;
                        setAllocations(prev => {
                          const copy = prev.filter(a => a.target_account !== acct);
                          if (val > 0) copy.push({ target_account: acct, amount: val, notes: '' });
                          return copy;
                        });
                      }}
                      placeholder="$0.00"
                    />
                    <input className="form-input" style={{ flex: 1 }}
                      value={existing?.notes || ''}
                      onChange={e => {
                        setAllocations(prev => prev.map(a =>
                          a.target_account === acct ? { ...a, notes: e.target.value } : a
                        ));
                      }}
                      placeholder="Notes..."
                    />
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                Allocated: {fmtMoney(allocations.reduce((s, a) => s + a.amount, 0))} of {fmtMoney(parseFloat(netPay))}
                {' '}({allocations.reduce((s, a) => s + a.amount, 0) > parseFloat(netPay)
                  ? <span style={{ color: 'var(--red)' }}>Over-allocated!</span>
                  : <span style={{ color: 'var(--green)' }}>
                    {fmtMoney(parseFloat(netPay) - allocations.reduce((s, a) => s + a.amount, 0))} remaining
                  </span>
                })
              </span>
            </div>

            <div className="btn-group" style={{ marginTop: '1rem' }}>
              {saved ? (
                <div className="success-msg" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <CheckCircle size={16} /> Allocations saved! Balances updated.
                </div>
              ) : (
                <>
                  <button className="btn btn-success" onClick={handleSaveAllocations} disabled={allocations.length === 0}>
                    <CheckCircle size={16} /> Confirm & Save Allocations
                  </button>
                  <button className="btn btn-ghost" onClick={() => { setStep(2); setAdvice(null); }}>Back</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Current Balances Summary */}
      <div className="card" style={{ marginTop: '1rem' }}>
        <div className="card-title">Current Account Balances</div>
        <div className="stat-grid">
          {Object.entries(balances).map(([acct, bal]) => (
            <div key={acct} className="stat-card">
              <div className="stat-label" style={{ textTransform: 'capitalize' }}>{acct.replace('_', ' ')}</div>
              <div className={`stat-value ${acct === 'credit_card' && bal > 0 ? 'negative' : 'positive'}`}>
                {fmtMoney(bal)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
