import React, { useState } from 'react';
import { parseStatement, importStatement, checkDuplicates, addIncome } from '../api';
import { Upload, CheckCircle, AlertTriangle, Trash2, DollarSign, X, ArrowRight } from 'lucide-react';
import { CATEGORIES, getCategoryColor } from '../categoryColors';

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export default function Statements() {
  const [csvText, setCsvText] = useState('');
  const [transactions, setTransactions] = useState([]);
  const [incomeItems, setIncomeItems] = useState([]);
  const [dupeResults, setDupeResults] = useState([]); // parallel array to transactions
  const [parseError, setParseError] = useState('');
  const [parsing, setParsing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [imported, setImported] = useState(false);
  const [importCount, setImportCount] = useState(0);
  const [excludedIdxs, setExcludedIdxs] = useState(new Set());

  async function handleParse() {
    setParsing(true);
    setParseError('');
    setImported(false);
    setExcludedIdxs(new Set());
    setDupeResults([]);
    setIncomeItems([]);
    try {
      const result = await parseStatement(csvText);
      if (result.transactions.length === 0 && (!result.income_transactions || result.income_transactions.length === 0)) {
        setParseError('No transactions found. Make sure your CSV has dates, amounts, and descriptions.');
      } else {
        setTransactions(result.transactions);
        setIncomeItems(result.income_transactions || []);

        // Check for duplicates
        if (result.transactions.length > 0) {
          setChecking(true);
          try {
            const dupeCheck = await checkDuplicates(result.transactions);
            setDupeResults(dupeCheck.results || []);
            // Auto-exclude exact matches and previously deleted
            const autoExclude = new Set();
            (dupeCheck.results || []).forEach((r, i) => {
              if (r.is_duplicate) autoExclude.add(i);
            });
            setExcludedIdxs(autoExclude);
          } catch (err) {
            console.error('Dupe check failed:', err);
          }
          setChecking(false);
        }
      }
    } catch (err) {
      setParseError(err.message);
    }
    setParsing(false);
  }

  async function handleImport() {
    const toImport = transactions.filter((_, i) => !excludedIdxs.has(i));
    if (toImport.length === 0) { alert('No transactions to import (all excluded).'); return; }
    try {
      await importStatement(toImport);
      setImported(true);
      setImportCount(toImport.length);
      setTransactions([]);
      setCsvText('');
      setDupeResults([]);
      setExcludedIdxs(new Set());
    } catch (err) {
      alert(err.message);
    }
  }

  function toggleExclude(idx) {
    setExcludedIdxs(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function updateTxn(idx, field, value) {
    setTransactions(prev => prev.map((t, i) => i === idx ? { ...t, [field]: value } : t));
  }

  function removeTxn(idx) {
    setTransactions(prev => prev.filter((_, i) => i !== idx));
    setDupeResults(prev => prev.filter((_, i) => i !== idx));
    setExcludedIdxs(prev => {
      const next = new Set();
      prev.forEach(v => { if (v < idx) next.add(v); else if (v > idx) next.add(v - 1); });
      return next;
    });
  }

  function moveIncomeToExpenses(idx) {
    const item = incomeItems[idx];
    setTransactions(prev => [...prev, {
      expense_date: item.expense_date,
      description: item.description,
      amount: item.amount,
      category: 'Other',
      entry_type: 'actual',
      source: 'statement'
    }]);
    setDupeResults(prev => [...prev, { transaction: item, exact_matches: [], near_matches: [], was_deleted: false, is_duplicate: false }]);
    setIncomeItems(prev => prev.filter((_, i) => i !== idx));
  }

  function removeIncomeItem(idx) {
    setIncomeItems(prev => prev.filter((_, i) => i !== idx));
  }

  const activeTransactions = transactions.filter((_, i) => !excludedIdxs.has(i));
  const total = activeTransactions.reduce((s, t) => s + t.amount, 0);
  const byCategory = {};
  activeTransactions.forEach(t => {
    if (!byCategory[t.category]) byCategory[t.category] = 0;
    byCategory[t.category] += t.amount;
  });

  const dupeCount = [...excludedIdxs].length;

  return (
    <div>
      <div className="page-header">
        <h2>Import Statement</h2>
        <p>Paste your credit card or bank statement CSV to add transactions to your spending history</p>
      </div>

      {/* Step 1: Paste CSV */}
      {transactions.length === 0 && !imported && (
        <div className="card">
          <div className="card-title">Paste Statement CSV</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Export a CSV from your bank/credit card provider and paste the contents below.
            The parser will auto-detect columns, categorise transactions, and separate income/credits.
          </p>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Supported formats: Most AU bank CSVs with Date, Amount/Debit, and Description columns.
            Salaries, refunds, and credits are automatically detected as income.
          </p>
          <div className="form-group">
            <label>CSV Data</label>
            <textarea
              className="form-input"
              rows={12}
              value={csvText}
              onChange={e => setCsvText(e.target.value)}
              placeholder={'Date,Amount,Description\n25/02/2026,45.50,WOOLWORTHS SYDNEY\n25/02/2026,12.00,UBER EATS\n...'}
              style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}
            />
          </div>
          {parseError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--red)', marginBottom: '1rem', fontSize: '0.85rem' }}>
              <AlertTriangle size={16} /> {parseError}
            </div>
          )}
          <button className="btn btn-primary" onClick={handleParse} disabled={!csvText.trim() || parsing}>
            {parsing ? <><div className="spinner" /> Parsing...</> : <><Upload size={16} /> Parse Statement</>}
          </button>
        </div>
      )}

      {/* Income Detected */}
      {incomeItems.length > 0 && (
        <div className="income-detected">
          <DollarSign size={20} style={{ color: 'var(--green)', flexShrink: 0, marginTop: 2 }} />
          <div className="income-detected-list">
            <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--green)' }}>
              {incomeItems.length} income/credit transaction{incomeItems.length !== 1 ? 's' : ''} detected
            </div>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              These look like salary, refunds, or credits. They've been separated from expenses. You can move any back to expenses if they're miscategorised.
            </p>
            {incomeItems.map((item, idx) => (
              <div key={idx} className="income-item">
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginRight: '0.5rem' }}>{item.expense_date}</span>
                <span className="income-item-desc">{item.description}</span>
                <span className="income-item-amount">{fmtMoney(item.amount)}</span>
                <div className="income-item-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => moveIncomeToExpenses(idx)} title="Move to expenses">
                    <ArrowRight size={12} /> Expense
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => removeIncomeItem(idx)} title="Dismiss">
                    <X size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Step 2: Review Transactions */}
      {transactions.length > 0 && (
        <div>
          {checking && (
            <div className="card" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div className="spinner" /> Checking for duplicates...
            </div>
          )}

          <div className="card" style={{ marginBottom: '1rem' }}>
            <div className="card-title">Review Transactions ({transactions.length})</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              Review the parsed transactions below. Edit categories, descriptions, or remove rows before importing.
              Total (active): <strong>{fmtMoney(total)}</strong>
            </p>
            {dupeCount > 0 && (
              <div className="dupe-warning" style={{ marginBottom: '0.75rem' }}>
                <AlertTriangle size={14} />
                {dupeCount} potential duplicate{dupeCount !== 1 ? 's' : ''} found and auto-excluded. Click "Include" to import anyway.
              </div>
            )}

            {/* Category summary */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
              {Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => (
                <span key={cat} className="tag" style={{ fontSize: '0.75rem', background: `${getCategoryColor(cat)}22`, color: getCategoryColor(cat) }}>
                  {cat}: {fmtMoney(amt)}
                </span>
              ))}
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Amount</th>
                    <th>Category</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t, idx) => {
                    const dupe = dupeResults[idx];
                    const isExcluded = excludedIdxs.has(idx);
                    const hasExactMatch = dupe?.exact_matches?.length > 0;
                    const hasNearMatch = dupe?.near_matches?.length > 0;
                    const wasDeleted = dupe?.was_deleted;
                    return (
                      <tr key={idx} className={isExcluded ? 'dupe-row excluded' : (hasExactMatch || wasDeleted ? 'dupe-row' : '')}>
                        <td style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>{t.expense_date}</td>
                        <td>
                          <input className="form-input" value={t.description}
                            onChange={e => updateTxn(idx, 'description', e.target.value)}
                            style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem', minWidth: 200 }} />
                        </td>
                        <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtMoney(t.amount)}</td>
                        <td>
                          <select className="form-select" value={t.category}
                            onChange={e => updateTxn(idx, 'category', e.target.value)}
                            style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem', borderLeftColor: getCategoryColor(t.category), borderLeftWidth: 3 }}>
                            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                        <td>
                          {hasExactMatch && (
                            <div className="dupe-warning dupe-exact" style={{ marginBottom: 0 }}>
                              Duplicate — matches: {dupe.exact_matches.map(m => m.description || m.category).join(', ')}
                            </div>
                          )}
                          {!hasExactMatch && hasNearMatch && (
                            <div className="dupe-warning" style={{ marginBottom: 0 }}>
                              Similar — {dupe.near_matches[0].description} ({fmtMoney(dupe.near_matches[0].amount)})
                            </div>
                          )}
                          {wasDeleted && (
                            <div className="dupe-warning dupe-deleted" style={{ marginBottom: 0 }}>
                              Previously deleted
                            </div>
                          )}
                          {!hasExactMatch && !hasNearMatch && !wasDeleted && (
                            <span className="tag tag-green">New</span>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                            {(hasExactMatch || hasNearMatch || wasDeleted) && (
                              <button className="dupe-toggle" onClick={() => toggleExclude(idx)}>
                                {isExcluded ? 'Include' : 'Exclude'}
                              </button>
                            )}
                            <button className="btn btn-ghost btn-sm" onClick={() => removeTxn(idx)} title="Remove">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="btn-group">
            <button className="btn btn-success" onClick={handleImport}>
              <CheckCircle size={16} /> Import {activeTransactions.length} Transactions ({fmtMoney(total)})
            </button>
            <button className="btn btn-ghost" onClick={() => { setTransactions([]); setDupeResults([]); setIncomeItems([]); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Success message */}
      {imported && (
        <div className="card">
          <div className="success-msg" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <CheckCircle size={20} /> Successfully imported {importCount} transactions as expenses!
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            The transactions have been added to your expense history. They'll now appear in your Dashboard,
            budget tracking, and Claude's analysis.
          </p>
          <button className="btn btn-primary" onClick={() => setImported(false)}>
            <Upload size={16} /> Import Another Statement
          </button>
        </div>
      )}
    </div>
  );
}
