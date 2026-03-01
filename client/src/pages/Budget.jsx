import React, { useState, useEffect } from 'react';
import { getBudgets, updateBudget, getExpenses } from '../api';
import { Edit3, Check, X, DollarSign } from 'lucide-react';

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }

export default function Budget() {
  const [budgets, setBudgets] = useState([]);
  const [monthExpenses, setMonthExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [editValue, setEditValue] = useState('');

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    try {
      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const [budgetData, expenseData] = await Promise.all([
        getBudgets(),
        getExpenses({ start: monthStart })
      ]);
      setBudgets(budgetData);
      setMonthExpenses(expenseData);
    } catch (err) { console.error(err); }
    setLoading(false);
  }

  // Actual spending by category this month
  const actualByCategory = {};
  monthExpenses.forEach(e => {
    actualByCategory[e.category] = (actualByCategory[e.category] || 0) + e.amount;
  });

  async function saveBudget(category) {
    const amount = parseFloat(editValue);
    if (isNaN(amount) || amount < 0) return;
    try {
      await updateBudget(category, amount);
      setEditing(null);
      loadData();
    } catch (err) { alert(err.message); }
  }

  const totalBudget = budgets.reduce((s, b) => s + b.monthly_amount, 0);
  const totalActual = Object.values(actualByCategory).reduce((s, v) => s + v, 0);
  const remaining = totalBudget - totalActual;

  if (loading) return <div style={{ textAlign: 'center', padding: '2rem' }}><div className="spinner" /></div>;

  return (
    <div>
      {/* Overview Cards */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="stat-card">
          <div className="stat-label">Monthly Budget</div>
          <div className="stat-value neutral">{fmtMoney(totalBudget)}</div>
          <div className="card-sub">across {budgets.length} categories</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Spent This Month</div>
          <div className="stat-value negative">{fmtMoney(totalActual)}</div>
          <div className="card-sub">{monthExpenses.length} transactions</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Remaining</div>
          <div className={`stat-value ${remaining >= 0 ? 'positive' : 'negative'}`}>
            {remaining >= 0 ? '' : '-'}{fmtMoney(Math.abs(remaining))}
          </div>
          <div className="card-sub">{remaining >= 0 ? 'under budget' : 'over budget'}</div>
        </div>
      </div>

      {/* Overall Progress */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.35rem' }}>
          <span style={{ fontWeight: 600 }}>Overall Budget Usage</span>
          <span style={{ color: 'var(--text-muted)' }}>
            {totalBudget > 0 ? Math.round((totalActual / totalBudget) * 100) : 0}%
          </span>
        </div>
        <div className="progress-bar" style={{ height: 12 }}>
          <div
            className={`progress-fill ${totalBudget > 0 && totalActual / totalBudget <= 0.75 ? 'green' : totalActual / totalBudget <= 1 ? 'yellow' : 'red'}`}
            style={{ width: `${Math.min(100, totalBudget > 0 ? (totalActual / totalBudget) * 100 : 0)}%` }}
          />
        </div>
      </div>

      {/* Category Budgets */}
      <div className="card">
        <div className="card-title"><DollarSign size={14} /> Category Budgets</div>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
          Tap a budget amount to edit. Changes apply immediately.
        </p>

        {budgets.map(b => {
          const actual = actualByCategory[b.category] || 0;
          const pct = b.monthly_amount > 0 ? (actual / b.monthly_amount) * 100 : 0;
          const isEditing = editing === b.category;

          return (
            <div key={b.category} className="budget-edit-row">
              <div className="budget-edit-header">
                <span className="budget-edit-cat">{b.category}</span>
                {isEditing ? (
                  <div className="budget-edit-input-group">
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>$</span>
                    <input
                      type="number"
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      autoFocus
                      onKeyDown={e => { if (e.key === 'Enter') saveBudget(b.category); if (e.key === 'Escape') setEditing(null); }}
                    />
                    <button className="budget-edit-save" onClick={() => saveBudget(b.category)}><Check size={14} /></button>
                    <button className="budget-edit-cancel" onClick={() => setEditing(null)}><X size={14} /></button>
                  </div>
                ) : (
                  <div className="budget-edit-values" onClick={() => { setEditing(b.category); setEditValue(b.monthly_amount); }}>
                    <span className="budget-edit-amount">{fmtMoney(b.monthly_amount)}/mo</span>
                    <Edit3 size={12} style={{ color: 'var(--text-muted)', marginLeft: '0.35rem' }} />
                  </div>
                )}
              </div>
              <div className="budget-edit-bar-row">
                <div className="progress-bar" style={{ height: 6, margin: 0, flex: 1 }}>
                  <div
                    className={`progress-fill ${pct <= 75 ? 'green' : pct <= 100 ? 'yellow' : 'red'}`}
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
                <span className={`budget-edit-spent ${pct > 100 ? 'over' : ''}`}>
                  {fmtMoney(actual)} ({pct.toFixed(0)}%)
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
