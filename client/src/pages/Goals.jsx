import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getGoals, addGoal, updateGoal, deleteGoal, getLevers, addLever, updateLever, deleteLever, getBalances, getRetention, updateRetention } from '../api';
import { Target, Sliders, Plus, Trash2, Edit3, Shield } from 'lucide-react';

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
const bucketColors = ['#6c5ce7', '#00cec9', '#fd79a8', '#fdcb6e', '#e17055', '#55efc4'];

export default function Goals() {
  const { user } = useAuth();
  const [tab, setTab] = useState('goals');
  const [goals, setGoals] = useState([]);
  const [levers, setLevers] = useState([]);
  const [balances, setBalances] = useState({});
  const [retention, setRetention] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', target_amount: '', current_amount: '', priority: 5, target_date: '', is_joint: true });
  const [editId, setEditId] = useState(null);
  const [leverForm, setLeverForm] = useState({ name: '', lever_type: 'percentage', value: '', description: '' });

  useEffect(() => {
    getGoals().then(setGoals).catch(console.error);
    getLevers().then(setLevers).catch(console.error);
    getBalances().then(setBalances).catch(console.error);
    if (user) getRetention(user.id).then(setRetention).catch(console.error);
  }, [user]);

  const offsetBalance = balances.offset || 0;
  const totalGoalAllocated = goals.reduce((s, g) => s + (g.current_amount || 0), 0);
  const unallocated = offsetBalance - totalGoalAllocated;
  const overAllocated = totalGoalAllocated > offsetBalance;

  async function handleAddGoal(e) {
    e.preventDefault();
    const g = await addGoal({
      name: form.name, target_amount: parseFloat(form.target_amount),
      current_amount: parseFloat(form.current_amount) || 0,
      priority: parseInt(form.priority) || 5,
      target_date: form.target_date || null,
      is_joint: form.is_joint
    });
    setGoals(prev => [...prev, g]);
    setForm({ name: '', target_amount: '', current_amount: '', priority: 5, target_date: '', is_joint: true });
    setShowAdd(false);
  }

  async function handleUpdateGoal(id, field, value) {
    const updated = await updateGoal(id, { [field]: value });
    setGoals(prev => prev.map(g => g.id === id ? { ...g, ...updated } : g));
    setEditId(null);
  }

  async function handleDeleteGoal(id) {
    await deleteGoal(id);
    setGoals(prev => prev.filter(g => g.id !== id));
  }

  async function handleAddLever(e) {
    e.preventDefault();
    const l = await addLever({ ...leverForm, value: parseFloat(leverForm.value) });
    setLevers(prev => [...prev, l]);
    setLeverForm({ name: '', lever_type: 'percentage', value: '', description: '' });
  }

  async function handleRetentionSave() {
    if (!user || !retention) return;
    await updateRetention(user.id, {
      retention_method: retention.profile?.retention_method,
      fixed_amount: parseFloat(retention.profile?.fixed_amount) || 0,
      buffer_percent: parseFloat(retention.profile?.buffer_percent) || 10,
      lookback_weeks: parseInt(retention.profile?.lookback_weeks) || 8,
      expense_source: retention.profile?.expense_source || 'all'
    });
    const updated = await getRetention(user.id);
    setRetention(updated);
  }

  return (
    <div>
      <div className="page-header">
        <h2>Offset Goals & Settings</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Manage virtual buckets within your offset account</p>
      </div>

      <div className="tabs" style={{ marginBottom: '1.5rem' }}>
        <button className={`tab ${tab === 'goals' ? 'active' : ''}`} onClick={() => setTab('goals')}><Target size={14} /> Offset Goals</button>
        <button className={`tab ${tab === 'retention' ? 'active' : ''}`} onClick={() => setTab('retention')}><Shield size={14} /> Retention</button>
        <button className={`tab ${tab === 'levers' ? 'active' : ''}`} onClick={() => setTab('levers')}><Sliders size={14} /> Budget Scale</button>
      </div>

      {tab === 'goals' && (
        <div>
          <div className="card offset-hero-card" style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)' }}>Offset Balance</div>
                <div style={{ fontSize: '1.8rem', fontWeight: 800 }}>{fmtMoney(offsetBalance)}</div>
              </div>
              <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--accent)' }}>{fmtMoney(totalGoalAllocated)}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Earmarked</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '1.1rem', fontWeight: 700, color: overAllocated ? 'var(--red)' : 'var(--green)' }}>{fmtMoney(unallocated)}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Free</div>
                </div>
              </div>
            </div>
            {overAllocated && (
              <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', background: 'rgba(255,100,100,0.1)', borderRadius: 6, fontSize: '0.8rem', color: 'var(--red)' }}>
                Goals exceed offset by {fmtMoney(Math.abs(unallocated))}
              </div>
            )}
            {goals.length > 0 && (
              <div style={{ marginTop: '1rem' }}>
                <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', background: 'var(--bg-input)' }}>
                  {goals.map((g, i) => {
                    const w = offsetBalance > 0 ? (g.current_amount / offsetBalance * 100) : 0;
                    return w > 0 ? <div key={g.id} style={{ width: `${w}%`, background: bucketColors[i % bucketColors.length], transition: 'width 0.3s' }} /> : null;
                  })}
                </div>
              </div>
            )}
          </div>

          {goals.map((g, i) => {
            const pct = g.target_amount > 0 ? (g.current_amount / g.target_amount * 100) : 0;
            return (
              <div key={g.id} className="card" style={{ borderLeft: `4px solid ${bucketColors[i % bucketColors.length]}`, marginBottom: '0.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 4 }}>{g.name}</div>
                    <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                      <span>Priority: {g.priority}</span>
                      {g.target_date && <span>Target: {g.target_date}</span>}
                      <span>{g.is_joint ? 'Joint' : 'Individual'}</span>
                    </div>
                    <div className="progress-bar" style={{ height: 10, marginBottom: 4 }}>
                      <div className="progress-fill" style={{ width: `${Math.min(100, pct)}%`, background: bucketColors[i % bucketColors.length] }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                      <span style={{ fontWeight: 600 }}>{fmtMoney(g.current_amount)} / {fmtMoney(g.target_amount)}</span>
                      <span style={{ color: pct >= 100 ? 'var(--green)' : 'var(--text-muted)' }}>{pct.toFixed(0)}%{pct >= 100 && ' Complete!'}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.25rem', marginLeft: '1rem' }}>
                    {editId === g.id ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <input className="form-input" type="number" step="1" defaultValue={g.current_amount} style={{ width: 100 }}
                          onBlur={e => handleUpdateGoal(g.id, 'current_amount', parseFloat(e.target.value))} autoFocus />
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditId(null)}>Done</button>
                      </div>
                    ) : (
                      <>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditId(g.id)}><Edit3 size={14} /></button>
                        <button className="btn btn-ghost btn-sm" onClick={() => handleDeleteGoal(g.id)}><Trash2 size={14} /></button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {showAdd ? (
            <form onSubmit={handleAddGoal} className="card">
              <div className="card-title">New Offset Goal</div>
              <div className="form-row">
                <div className="form-group"><label>Name</label><input className="form-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="e.g. Emergency Fund" /></div>
                <div className="form-group"><label>Target ($)</label><input className="form-input" type="number" value={form.target_amount} onChange={e => setForm({ ...form, target_amount: e.target.value })} required /></div>
              </div>
              <div className="form-row">
                <div className="form-group"><label>Current ($)</label><input className="form-input" type="number" value={form.current_amount} onChange={e => setForm({ ...form, current_amount: e.target.value })} placeholder="0" /></div>
                <div className="form-group"><label>Priority</label><input className="form-input" type="number" min="1" max="10" value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })} /></div>
                <div className="form-group"><label>Target Date</label><input className="form-input" type="date" value={form.target_date} onChange={e => setForm({ ...form, target_date: e.target.value })} /></div>
              </div>
              <div className="btn-group">
                <button className="btn btn-primary" type="submit"><Plus size={14} /> Add Goal</button>
                <button className="btn btn-ghost" type="button" onClick={() => setShowAdd(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <button className="btn btn-primary" onClick={() => setShowAdd(true)}><Plus size={14} /> Add Goal</button>
          )}
        </div>
      )}

      {tab === 'retention' && retention && (
        <div>
          <div className="card">
            <div className="card-title"><Shield size={18} /> Retention Settings</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
              Configure how much you keep from each pay for expenses. The rest goes to offset.
            </p>
            <div className="form-row">
              <div className="form-group">
                <label>Method</label>
                <select className="form-select" value={retention.profile?.retention_method || 'auto'}
                  onChange={e => setRetention(prev => ({ ...prev, profile: { ...prev.profile, retention_method: e.target.value } }))}>
                  <option value="auto">Auto-calculate</option>
                  <option value="fixed">Fixed amount</option>
                </select>
              </div>
              {retention.profile?.retention_method === 'fixed' && (
                <div className="form-group"><label>Fixed Amount ($)</label><input className="form-input" type="number" step="0.01" value={retention.profile?.fixed_amount || ''} onChange={e => setRetention(prev => ({ ...prev, profile: { ...prev.profile, fixed_amount: e.target.value } }))} /></div>
              )}
            </div>
            {retention.profile?.retention_method !== 'fixed' && (
              <div className="form-row">
                <div className="form-group"><label>Lookback (weeks)</label><input className="form-input" type="number" min="2" max="26" value={retention.profile?.lookback_weeks || 8} onChange={e => setRetention(prev => ({ ...prev, profile: { ...prev.profile, lookback_weeks: e.target.value } }))} /></div>
                <div className="form-group"><label>Buffer %</label><input className="form-input" type="number" min="0" max="50" value={retention.profile?.buffer_percent || 10} onChange={e => setRetention(prev => ({ ...prev, profile: { ...prev.profile, buffer_percent: e.target.value } }))} /></div>
                <div className="form-group"><label>Expense Source</label><select className="form-select" value={retention.profile?.expense_source || 'all'} onChange={e => setRetention(prev => ({ ...prev, profile: { ...prev.profile, expense_source: e.target.value } }))}><option value="all">All</option><option value="credit_card">Credit card</option><option value="direct">Direct/debit</option></select></div>
              </div>
            )}
            <button className="btn btn-primary" onClick={handleRetentionSave}><Shield size={14} /> Save</button>
          </div>

          <div className="card" style={{ marginTop: '1rem' }}>
            <div className="card-title">Current Calculation</div>
            <div className="retention-breakdown">
              <div className="retention-row"><span>Avg spend per {retention.pay_period}</span><span>{fmtMoney(retention.avg_per_period)}</span></div>
              <div className="retention-row"><span>Buffer ({retention.profile?.buffer_percent || 10}%)</span><span>+{fmtMoney(retention.buffer_amount)}</span></div>
              {retention.upcoming_extra > 0 && <div className="retention-row"><span>Upcoming</span><span>+{fmtMoney(retention.upcoming_extra)}</span></div>}
              <div className="retention-row total"><span>Recommended</span><span>{fmtMoney(retention.calculated_retention)}</span></div>
            </div>
            {retention.by_category && Object.keys(retention.by_category).length > 0 && (
              <div style={{ marginTop: '1rem' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>By Category (per period)</div>
                {Object.entries(retention.by_category).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => (
                  <div key={cat} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border)', fontSize: '0.8rem' }}><span>{cat}</span><span style={{ fontWeight: 600 }}>{fmtMoney(amt)}</span></div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'levers' && (
        <div>
          {levers.map(l => (
            <div key={l.id} className="card" style={{ marginBottom: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{l.name}</div>
                  {l.description && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 2 }}>{l.description}</div>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input className="form-input" type="number" step="1" style={{ width: 80, textAlign: 'center', fontWeight: 700 }} defaultValue={l.value}
                    onBlur={e => updateLever(l.id, { value: parseFloat(e.target.value) }).then(() => getLevers().then(setLevers))} />
                  <span style={{ color: 'var(--text-muted)' }}>{l.lever_type === 'percentage' ? '%' : '$'}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => { deleteLever(l.id); setLevers(prev => prev.filter(x => x.id !== l.id)); }}><Trash2 size={14} /></button>
                </div>
              </div>
            </div>
          ))}
          <div className="card" style={{ marginTop: '1rem' }}>
            <div className="card-title">Add Lever</div>
            <form onSubmit={handleAddLever}>
              <div className="form-row">
                <div className="form-group"><label>Name</label><input className="form-input" value={leverForm.name} onChange={e => setLeverForm({ ...leverForm, name: e.target.value })} required /></div>
                <div className="form-group"><label>Type</label><select className="form-select" value={leverForm.lever_type} onChange={e => setLeverForm({ ...leverForm, lever_type: e.target.value })}><option value="percentage">Percentage</option><option value="dollar">Dollar</option></select></div>
                <div className="form-group"><label>Value</label><input className="form-input" type="number" value={leverForm.value} onChange={e => setLeverForm({ ...leverForm, value: e.target.value })} required /></div>
              </div>
              <div className="form-group"><label>Description</label><input className="form-input" value={leverForm.description} onChange={e => setLeverForm({ ...leverForm, description: e.target.value })} /></div>
              <button className="btn btn-primary" type="submit"><Plus size={14} /> Add</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
