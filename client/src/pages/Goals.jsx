import React, { useState, useEffect } from 'react';
import { getGoals, addGoal, updateGoal, deleteGoal, getLevers, addLever, updateLever, deleteLever } from '../api';
import { Target, Sliders, Plus, Save, Trash2, Edit3 } from 'lucide-react';

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }

export default function Goals() {
  const [goals, setGoals] = useState([]);
  const [levers, setLevers] = useState([]);
  const [tab, setTab] = useState('goals');
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [goalForm, setGoalForm] = useState({ name: '', target_amount: '', current_amount: '', priority: 5, target_date: '', is_joint: true });
  const [leverForm, setLeverForm] = useState({ name: '', description: '', lever_type: 'percentage', value: '' });
  const [showAddLever, setShowAddLever] = useState(false);

  useEffect(() => {
    getGoals().then(setGoals).catch(console.error);
    getLevers().then(setLevers).catch(console.error);
  }, []);

  async function handleAddGoal(e) {
    e.preventDefault();
    try {
      const goal = await addGoal({
        ...goalForm,
        target_amount: parseFloat(goalForm.target_amount),
        current_amount: parseFloat(goalForm.current_amount) || 0,
        priority: parseInt(goalForm.priority)
      });
      setGoals(prev => [...prev, goal].sort((a, b) => a.priority - b.priority));
      setGoalForm({ name: '', target_amount: '', current_amount: '', priority: 5, target_date: '', is_joint: true });
      setShowAdd(false);
    } catch (err) { alert(err.message); }
  }

  async function handleUpdateGoal(id) {
    try {
      const goal = goals.find(g => g.id === id);
      const updated = await updateGoal(id, goal);
      setGoals(prev => prev.map(g => g.id === id ? { ...g, ...updated } : g));
      setEditId(null);
    } catch (err) { alert(err.message); }
  }

  async function handleDeleteGoal(id) {
    if (!confirm('Deactivate this goal?')) return;
    await deleteGoal(id);
    setGoals(prev => prev.filter(g => g.id !== id));
  }

  async function handleAddLever(e) {
    e.preventDefault();
    try {
      const lever = await addLever({ ...leverForm, value: parseFloat(leverForm.value) });
      setLevers(prev => [...prev, lever]);
      setLeverForm({ name: '', description: '', lever_type: 'percentage', value: '' });
      setShowAddLever(false);
    } catch (err) { alert(err.message); }
  }

  async function handleUpdateLever(id, value) {
    try {
      const updated = await updateLever(id, { value: parseFloat(value) });
      setLevers(prev => prev.map(l => l.id === id ? { ...l, ...updated } : l));
    } catch (err) { alert(err.message); }
  }

  async function handleDeleteLever(id) {
    if (!confirm('Deactivate this lever?')) return;
    await deleteLever(id);
    setLevers(prev => prev.filter(l => l.id !== id));
  }

  return (
    <div>
      <div className="page-header">
        <h2>Goals & Levers</h2>
        <p>Set savings targets and allocation preferences</p>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'goals' ? 'active' : ''}`} onClick={() => setTab('goals')}>
          <Target size={14} style={{ marginRight: 4 }} /> Savings Goals
        </button>
        <button className={`tab ${tab === 'levers' ? 'active' : ''}`} onClick={() => setTab('levers')}>
          <Sliders size={14} style={{ marginRight: 4 }} /> Allocation Levers
        </button>
      </div>

      {tab === 'goals' && (
        <div>
          <button className="btn btn-primary" onClick={() => setShowAdd(!showAdd)} style={{ marginBottom: '1rem' }}>
            <Plus size={16} /> Add Goal
          </button>

          {showAdd && (
            <form className="card" onSubmit={handleAddGoal}>
              <div className="form-row">
                <div className="form-group">
                  <label>Goal Name</label>
                  <input className="form-input" value={goalForm.name} onChange={e => setGoalForm({ ...goalForm, name: e.target.value })} required placeholder="e.g. Holiday Fund" />
                </div>
                <div className="form-group">
                  <label>Target Amount ($)</label>
                  <input className="form-input" type="number" value={goalForm.target_amount} onChange={e => setGoalForm({ ...goalForm, target_amount: e.target.value })} required />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Current Amount ($)</label>
                  <input className="form-input" type="number" value={goalForm.current_amount} onChange={e => setGoalForm({ ...goalForm, current_amount: e.target.value })} placeholder="0" />
                </div>
                <div className="form-group">
                  <label>Priority (1=highest)</label>
                  <input className="form-input" type="number" min="1" max="10" value={goalForm.priority} onChange={e => setGoalForm({ ...goalForm, priority: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Target Date</label>
                  <input className="form-input" type="date" value={goalForm.target_date} onChange={e => setGoalForm({ ...goalForm, target_date: e.target.value })} />
                </div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', marginBottom: '1rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={goalForm.is_joint} onChange={e => setGoalForm({ ...goalForm, is_joint: e.target.checked })} />
                Joint goal (both partners)
              </label>
              <button className="btn btn-primary" type="submit"><Save size={14} /> Save Goal</button>
            </form>
          )}

          {goals.map(g => {
            const pct = g.target_amount > 0 ? Math.min(100, (g.current_amount / g.target_amount) * 100) : 0;
            const isEditing = editId === g.id;
            return (
              <div key={g.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    {isEditing ? (
                      <div className="form-row" style={{ marginBottom: '0.5rem' }}>
                        <input className="form-input" value={g.name} onChange={e => setGoals(prev => prev.map(x => x.id === g.id ? { ...x, name: e.target.value } : x))} />
                        <input className="form-input" type="number" value={g.target_amount} onChange={e => setGoals(prev => prev.map(x => x.id === g.id ? { ...x, target_amount: parseFloat(e.target.value) } : x))} />
                        <input className="form-input" type="number" value={g.current_amount} onChange={e => setGoals(prev => prev.map(x => x.id === g.id ? { ...x, current_amount: parseFloat(e.target.value) } : x))} />
                      </div>
                    ) : (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontWeight: 700, fontSize: '1rem' }}>{g.name}</span>
                          <span className={`tag ${g.is_joint ? 'tag-blue' : 'tag-yellow'}`}>{g.is_joint ? 'Joint' : 'Personal'}</span>
                          <span className="tag tag-green">P{g.priority}</span>
                        </div>
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                          {fmtMoney(g.current_amount)} of {fmtMoney(g.target_amount)}
                          {g.target_date && <span> &middot; Target: {g.target_date}</span>}
                        </div>
                      </>
                    )}
                    <div className="progress-bar" style={{ marginTop: '0.5rem' }}>
                      <div className={`progress-fill ${pct >= 75 ? 'green' : pct >= 40 ? 'yellow' : ''}`} style={{ width: `${pct}%` }} />
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                      {pct.toFixed(1)}% complete &middot; {fmtMoney(g.target_amount - g.current_amount)} remaining
                    </div>
                  </div>
                  <div className="btn-group">
                    {isEditing ? (
                      <button className="btn btn-success btn-sm" onClick={() => handleUpdateGoal(g.id)}><Save size={14} /></button>
                    ) : (
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditId(g.id)}><Edit3 size={14} /></button>
                    )}
                    <button className="btn btn-ghost btn-sm" onClick={() => handleDeleteGoal(g.id)}><Trash2 size={14} /></button>
                  </div>
                </div>
              </div>
            );
          })}

          {goals.length === 0 && (
            <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
              No savings goals yet. Add one to start tracking!
            </div>
          )}
        </div>
      )}

      {tab === 'levers' && (
        <div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Levers control how surplus funds are allocated. Claude uses these when advising on pay day allocations.
            Either partner can adjust these.
          </p>

          <button className="btn btn-primary" onClick={() => setShowAddLever(!showAddLever)} style={{ marginBottom: '1rem' }}>
            <Plus size={16} /> Add Lever
          </button>

          {showAddLever && (
            <form className="card" onSubmit={handleAddLever}>
              <div className="form-row">
                <div className="form-group">
                  <label>Lever Name</label>
                  <input className="form-input" value={leverForm.name} onChange={e => setLeverForm({ ...leverForm, name: e.target.value })} required placeholder="e.g. Emergency Buffer %" />
                </div>
                <div className="form-group">
                  <label>Type</label>
                  <select className="form-select" value={leverForm.lever_type} onChange={e => setLeverForm({ ...leverForm, lever_type: e.target.value })}>
                    <option value="percentage">Percentage</option>
                    <option value="dollar">Dollar Amount</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Value</label>
                  <input className="form-input" type="number" step="0.01" value={leverForm.value} onChange={e => setLeverForm({ ...leverForm, value: e.target.value })} required />
                </div>
              </div>
              <div className="form-group">
                <label>Description</label>
                <input className="form-input" value={leverForm.description} onChange={e => setLeverForm({ ...leverForm, description: e.target.value })} placeholder="What does this lever control?" />
              </div>
              <button className="btn btn-primary" type="submit"><Save size={14} /> Save Lever</button>
            </form>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {levers.map(l => (
              <div key={l.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{l.name}</div>
                  {l.description && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{l.description}</div>}
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                    Set by {l.set_by_name} &middot; {l.lever_type}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input className="form-input" type="number" step={l.lever_type === 'percentage' ? '1' : '0.01'}
                    style={{ width: 100, textAlign: 'right', fontWeight: 700, fontSize: '1.1rem' }}
                    value={l.value}
                    onChange={e => setLevers(prev => prev.map(x => x.id === l.id ? { ...x, value: e.target.value } : x))}
                  />
                  <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>
                    {l.lever_type === 'percentage' ? '%' : '$'}
                  </span>
                  <button className="btn btn-success btn-sm" onClick={() => handleUpdateLever(l.id, l.value)}>
                    <Save size={14} />
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => handleDeleteLever(l.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {levers.length === 0 && (
            <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
              No levers set yet. Add allocation preferences to guide Claude's advice.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
