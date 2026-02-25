import React, { useState } from 'react';
import { parseStatement, importStatement } from '../api';
import { Upload, CheckCircle, AlertTriangle, Edit3, Trash2 } from 'lucide-react';

const CATEGORIES = [
  'Groceries', 'Dining Out', 'Transport', 'Utilities', 'Insurance',
  'Entertainment', 'Health', 'Clothing', 'Personal Care', 'Subscriptions',
  'Pets', 'Gifts', 'Education', 'Home', 'Mortgage', 'Other'
];

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export default function Statements() {
  const [csvText, setCsvText] = useState('');
  const [transactions, setTransactions] = useState([]);
  const [parseError, setParseError] = useState('');
  const [parsing, setParsing] = useState(false);
  const [imported, setImported] = useState(false);
  const [importCount, setImportCount] = useState(0);

  async function handleParse() {
    setParsing(true);
    setParseError('');
    setImported(false);
    try {
      const result = await parseStatement(csvText);
      if (result.transactions.length === 0) {
        setParseError('No expense transactions found. Make sure your CSV has dates, amounts, and descriptions. Credits/payments are automatically excluded.');
      } else {
        setTransactions(result.transactions);
      }
    } catch (err) {
      setParseError(err.message);
    }
    setParsing(false);
  }

  async function handleImport() {
    try {
      const result = await importStatement(transactions);
      setImported(true);
      setImportCount(transactions.length);
      setTransactions([]);
      setCsvText('');
    } catch (err) {
      alert(err.message);
    }
  }

  function updateTxn(idx, field, value) {
    setTransactions(prev => prev.map((t, i) => i === idx ? { ...t, [field]: value } : t));
  }

  function removeTxn(idx) {
    setTransactions(prev => prev.filter((_, i) => i !== idx));
  }

  const total = transactions.reduce((s, t) => s + t.amount, 0);
  const byCategory = {};
  transactions.forEach(t => {
    if (!byCategory[t.category]) byCategory[t.category] = 0;
    byCategory[t.category] += t.amount;
  });

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
            The parser will auto-detect columns and categorise transactions.
          </p>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Supported formats: Most AU bank CSVs with Date, Amount/Debit, and Description columns.
            Credits and payments are automatically excluded (only expenses are imported).
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

      {/* Step 2: Review Transactions */}
      {transactions.length > 0 && (
        <div>
          <div className="card" style={{ marginBottom: '1rem' }}>
            <div className="card-title">Review Transactions ({transactions.length})</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
              Review the parsed transactions below. You can edit categories, descriptions, or remove rows before importing.
              Total: <strong>{fmtMoney(total)}</strong>
            </p>

            {/* Category summary */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
              {Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => (
                <span key={cat} className="tag tag-blue" style={{ fontSize: '0.75rem' }}>
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
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t, idx) => (
                    <tr key={idx}>
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
                          style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}>
                          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td>
                        <button className="btn btn-ghost btn-sm" onClick={() => removeTxn(idx)} title="Remove">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="btn-group">
            <button className="btn btn-success" onClick={handleImport}>
              <CheckCircle size={16} /> Import {transactions.length} Transactions ({fmtMoney(total)})
            </button>
            <button className="btn btn-ghost" onClick={() => { setTransactions([]); }}>
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
