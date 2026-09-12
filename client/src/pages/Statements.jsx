import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  parseStatement, importStatement, checkDuplicates, addIncome,
  extractScreenshot, importScreenshot,
  saveCategoryRule, getCategoryRules, deleteCategoryRule,
  recategorizeExpenses, getCategorizationGaps
} from '../api';
import {
  Upload, CheckCircle, AlertTriangle, Trash2, DollarSign, X, ArrowRight,
  FileText, Camera, Wand2, ChevronDown, ChevronRight, Filter, Save,
  RefreshCw, Tag, Check
} from 'lucide-react';
import { CATEGORIES, NON_SPENDING_CATEGORIES, getCategoryColor } from '../categoryColors';

/* ------------------------------------------------------------------ */
/* helpers — every one of these has to survive undefined/garbage input */
/* ------------------------------------------------------------------ */

function fmtMoney(n) {
  const v = Number(n);
  return '$' + (isFinite(v) ? v : 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function toNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return isFinite(n) ? n : 0;
}

// Mirrors the server's date handling well enough for the review table.
// Returns YYYY-MM-DD, or the trimmed original if we can't work it out.
function toISODate(raw) {
  if (raw == null) return '';
  const s = String(raw).trim().replace(/^"|"$/g, '').replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?(\s*[ap]\.?m\.?)?$/i, '').trim();
  if (!s) return '';
  const pad = (x) => String(parseInt(x, 10)).padStart(2, '0');
  const ok = (y, m, d) => {
    const yi = parseInt(y, 10), mi = parseInt(m, 10), di = parseInt(d, 10);
    if (!isFinite(yi) || !isFinite(mi) || !isFinite(di)) return null;
    if (mi < 1 || mi > 12 || di < 1 || di > 31 || yi < 1990 || yi > 2100) return null;
    return `${yi}-${pad(m)}-${pad(d)}`;
  };
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return ok(m[1], m[2], m[3]) || s;
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (m) {
    const useDayFirst = parseInt(m[1], 10) > 12 || parseInt(m[2], 10) <= 12;
    return (useDayFirst ? ok(m[3], m[2], m[1]) : ok(m[3], m[1], m[2])) || s;
  }
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2})$/);
  if (m) {
    const yr = parseInt(m[3], 10) < 70 ? `20${m[3]}` : `19${m[3]}`;
    const useDayFirst = parseInt(m[1], 10) > 12 || parseInt(m[2], 10) <= 12;
    return (useDayFirst ? ok(yr, m[2], m[1]) : ok(yr, m[1], m[2])) || s;
  }
  return s;
}

// Same shape as the server's suggested_pattern: first two words, lowercased.
function patternFor(description) {
  return String(description || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
}

function isNonSpending(category) {
  return (NON_SPENDING_CATEGORIES || []).indexOf(category) !== -1;
}

let ROW_SEQ = 0;
function nextRowId() { ROW_SEQ += 1; return ROW_SEQ; }

// Normalise both parser shapes (statement rows use expense_date,
// screenshot rows use date) into one row the review table understands.
function normalizeRow(raw, origin) {
  const src = raw || {};
  const category = src.category || 'Other';
  const confidence = src.confidence || 'medium';
  const is_transfer = src.is_transfer !== undefined ? !!src.is_transfer : isNonSpending(category);
  const needs_review = src.needs_review !== undefined ? !!src.needs_review : (confidence === 'low' || is_transfer);
  return {
    _id: nextRowId(),
    _origin: origin,
    expense_date: toISODate(src.expense_date || src.date),
    description: String(src.description || ''),
    amount: toNumber(src.amount),
    category,
    confidence,
    matched: src.matched || '',
    is_transfer,
    needs_review,
    entry_type: src.entry_type || 'actual',
    source: src.source || (origin === 'screenshot' ? 'screenshot' : 'credit_card_statement'),
  };
}

function apiShape(r) {
  return {
    expense_date: r.expense_date,
    description: r.description,
    amount: toNumber(r.amount),
    category: r.category,
    entry_type: r.entry_type || 'actual',
    source: r.source || 'credit_card_statement',
  };
}

const CONF_TAG = { high: 'tag-green', medium: 'tag-blue', low: 'tag-yellow' };

/* ------------------------------------------------------------------ */

export default function Statements() {
  const [tab, setTab] = useState('csv');

  // ---- CSV path
  const [csvText, setCsvText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const csvFileRef = useRef(null);

  // ---- Screenshot path
  const [extracting, setExtracting] = useState(false);
  const [shotProgress, setShotProgress] = useState(null); // { done, total }
  const [shotError, setShotError] = useState('');
  const shotFileRef = useRef(null);

  // ---- Shared review state
  const [meta, setMeta] = useState(null);          // parse summary (either path)
  const [rows, setRows] = useState([]);
  const [dupes, setDupes] = useState({});          // keyed by row._id
  const [excluded, setExcluded] = useState(new Set());
  const [selected, setSelected] = useState(new Set());
  const [checking, setChecking] = useState(false);
  const [onlyReview, setOnlyReview] = useState(false);
  const [bulkCategory, setBulkCategory] = useState('Groceries');
  const [ruleBusyId, setRuleBusyId] = useState(null);
  const [ruleMsg, setRuleMsg] = useState('');

  // ---- Income
  const [incomeItems, setIncomeItems] = useState([]);

  // ---- Import result
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [importCount, setImportCount] = useState(0);
  const [importNote, setImportNote] = useState('');

  // ---- Clean-up tools
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsLoaded, setToolsLoaded] = useState(false);
  const [toolMsg, setToolMsg] = useState('');
  const [recat, setRecat] = useState(null);
  const [recatLoading, setRecatLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [gaps, setGaps] = useState([]);
  const [gapsLoading, setGapsLoading] = useState(false);
  const [gapCats, setGapCats] = useState({});
  const [gapBusy, setGapBusy] = useState(null);
  const [rules, setRules] = useState([]);

  /* ---------------- derived ---------------- */

  const included = useMemo(() => rows.filter(r => !excluded.has(r._id)), [rows, excluded]);
  const total = useMemo(() => included.reduce((s, r) => s + toNumber(r.amount), 0), [included]);
  const byCategory = useMemo(() => {
    const acc = {};
    included.forEach(r => { const c = r.category || 'Other'; acc[c] = (acc[c] || 0) + toNumber(r.amount); });
    return acc;
  }, [included]);
  const visible = useMemo(
    () => (onlyReview ? rows.filter(r => r.needs_review || r.is_transfer || r.confidence === 'low') : rows),
    [rows, onlyReview]
  );
  const reviewCount = useMemo(
    () => rows.filter(r => r.needs_review || r.is_transfer || r.confidence === 'low').length,
    [rows]
  );
  const transferCount = useMemo(() => rows.filter(r => r.is_transfer).length, [rows]);
  const dupeCount = useMemo(
    () => rows.filter(r => (dupes[r._id] || {}).is_duplicate).length,
    [rows, dupes]
  );

  /* ---------------- shared plumbing ---------------- */

  function resetReview() {
    setRows([]); setDupes({}); setExcluded(new Set()); setSelected(new Set());
    setIncomeItems([]); setMeta(null); setOnlyReview(false); setRuleMsg('');
  }

  async function runDupeCheck(list) {
    // Transfers are money moving between your own accounts — never spending.
    const base = new Set(list.filter(r => r.is_transfer).map(r => r._id));
    setExcluded(base);
    if (!list.length) return;
    setChecking(true);
    try {
      const res = await checkDuplicates(list.map(apiShape));
      const results = Array.isArray(res && res.results) ? res.results : [];
      const map = {};
      const ex = new Set(base);
      results.forEach((r, i) => {
        const row = list[i];
        if (!row) return;
        map[row._id] = r || {};
        if (r && r.is_duplicate) ex.add(row._id);
      });
      setDupes(map);
      setExcluded(ex);
    } catch (err) {
      console.error('Dupe check failed:', err);
    }
    setChecking(false);
  }

  /* ---------------- A. CSV ---------------- */

  function readTextFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setCsvText(String(reader.result || '')); setParseError(''); };
    reader.onerror = () => setParseError('Could not read that file.');
    reader.readAsText(file);
  }

  async function handleParse() {
    setParsing(true);
    setParseError('');
    setImported(false);
    resetReview();
    try {
      const result = (await parseStatement(csvText)) || {};
      const txns = Array.isArray(result.transactions) ? result.transactions : [];
      const inc = Array.isArray(result.income_transactions) ? result.income_transactions : [];
      setMeta({
        kind: 'csv',
        delimiter: result.delimiter,
        had_header: !!result.had_header,
        row_count: result.row_count,
        skipped_rows: result.skipped_rows || 0,
        summary: result.summary || {},
      });
      setIncomeItems(inc);
      if (txns.length === 0 && inc.length === 0) {
        setParseError('No transactions found. Make sure your CSV has dates, amounts, and descriptions.');
      } else {
        const normalized = txns.map(t => normalizeRow(t, 'csv'));
        setRows(normalized);
        await runDupeCheck(normalized);
      }
    } catch (err) {
      setParseError((err && err.message) || 'Could not parse that statement.');
    }
    setParsing(false);
  }

  /* ---------------- B. Screenshots ---------------- */

  async function handleScreenshots(e) {
    const files = e && e.target && e.target.files ? Array.from(e.target.files) : [];
    if (!files.length) return;
    setExtracting(true);
    setShotError('');
    setImported(false);
    resetReview();
    setShotProgress({ done: 0, total: files.length });
    const collected = [];
    let lowConf = 0, transfers = 0, failed = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
            reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
            reader.readAsDataURL(file);
          });
          const result = (await extractScreenshot(base64, file.type || 'image/png')) || {};
          const txns = Array.isArray(result.transactions) ? result.transactions : [];
          txns.forEach(t => collected.push(normalizeRow(t, 'screenshot')));
          const s = result.summary || {};
          lowConf += toNumber(s.low_confidence);
          transfers += toNumber(s.transfers);
        } catch (err) {
          failed += 1;
          console.error('Screenshot extract failed:', err);
          setShotError((err && err.message) || 'One image could not be read.');
        }
        setShotProgress({ done: i + 1, total: files.length });
      }
      setMeta({
        kind: 'screenshot',
        files: files.length,
        failed,
        summary: { parsed: collected.length, low_confidence: lowConf, transfers },
      });
      if (!collected.length && !failed) setShotError('No transactions were found in those images.');
      if (collected.length) {
        setRows(collected);
        await runDupeCheck(collected);
      }
    } catch (err) {
      setShotError((err && err.message) || 'Screenshot import failed.');
    }
    setExtracting(false);
    setShotProgress(null);
    if (shotFileRef.current) shotFileRef.current.value = '';
  }

  /* ---------------- review table actions ---------------- */

  function updateRow(id, field, value) {
    setRows(prev => prev.map(r => (r._id === id ? { ...r, [field]: value } : r)));
  }

  function setCategoryFor(ids, category) {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (!idSet.size) return;
    const transfer = isNonSpending(category);
    setRows(prev => prev.map(r => (
      idSet.has(r._id)
        ? { ...r, category, is_transfer: transfer, needs_review: transfer }
        : r
    )));
    if (transfer) {
      setExcluded(prev => {
        const next = new Set(prev);
        idSet.forEach(id => next.add(id));
        return next;
      });
    }
  }

  function toggleExclude(id) {
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function setExcludedFor(ids, shouldExclude) {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    setExcluded(prev => {
      const next = new Set(prev);
      idSet.forEach(id => { if (shouldExclude) next.add(id); else next.delete(id); });
      return next;
    });
  }

  function toggleSelect(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function removeRow(id) {
    setRows(prev => prev.filter(r => r._id !== id));
    setDupes(prev => { const next = { ...prev }; delete next[id]; return next; });
    setExcluded(prev => { const next = new Set(prev); next.delete(id); return next; });
    setSelected(prev => { const next = new Set(prev); next.delete(id); return next; });
  }

  async function handleAlwaysCategorize(row) {
    const pattern = patternFor(row.description);
    if (!pattern || pattern.length < 2) {
      setRuleMsg('That description is too short to make a reliable rule from.');
      return;
    }
    setRuleBusyId(row._id);
    setRuleMsg('');
    try {
      await saveCategoryRule(pattern, row.category);
      const ids = rows.filter(r => String(r.description || '').toLowerCase().includes(pattern)).map(r => r._id);
      setCategoryFor(ids, row.category);
      setRuleMsg(`Saved rule "${pattern}" → ${row.category}. Updated ${ids.length} row${ids.length !== 1 ? 's' : ''} here, and it will apply to future imports.`);
      if (toolsLoaded) loadRules();
    } catch (err) {
      setRuleMsg((err && err.message) || 'Could not save that rule.');
    }
    setRuleBusyId(null);
  }

  async function handleImport() {
    const toImport = rows.filter(r => !excluded.has(r._id));
    if (!toImport.length) { alert('Nothing to import — every row is excluded.'); return; }
    setImporting(true);
    try {
      const csvRows = toImport.filter(r => r._origin !== 'screenshot');
      const shotRows = toImport.filter(r => r._origin === 'screenshot');
      let count = 0;
      const notes = [];
      if (csvRows.length) {
        await importStatement(csvRows.map(apiShape));
        count += csvRows.length;
      }
      if (shotRows.length) {
        const res = (await importScreenshot(shotRows.map(r => ({
          date: r.expense_date,
          description: r.description,
          amount: toNumber(r.amount),
          category: r.category,
        })))) || {};
        count += typeof res.added === 'number' ? res.added : shotRows.length;
        if (res.skipped) notes.push(`${res.skipped} screenshot row${res.skipped !== 1 ? 's were' : ' was'} skipped by the server (already present, previously deleted, or unreadable).`);
      }
      setImportCount(count);
      setImportNote(notes.join(' '));
      setImported(true);
      resetReview();
      setCsvText('');
      if (toolsLoaded) loadGaps();
    } catch (err) {
      alert((err && err.message) || 'Import failed.');
    }
    setImporting(false);
  }

  /* ---------------- income ---------------- */

  function moveIncomeToExpenses(idx) {
    const item = incomeItems[idx];
    if (!item) return;
    const row = normalizeRow({
      expense_date: item.expense_date,
      description: item.description,
      amount: item.amount,
      category: 'Other',
      confidence: 'low',
      needs_review: true,
      entry_type: 'actual',
      source: 'statement',
    }, 'csv');
    setRows(prev => [...prev, row]);
    setIncomeItems(prev => prev.filter((_, i) => i !== idx));
  }

  async function saveIncomeRecord(idx) {
    const item = incomeItems[idx];
    if (!item) return;
    try {
      await addIncome({
        amount: toNumber(item.amount),
        pay_date: toISODate(item.expense_date),
        pay_type: 'regular',
        notes: item.description || 'From statement import',
      });
      setIncomeItems(prev => prev.filter((_, i) => i !== idx));
    } catch (err) {
      alert((err && err.message) || 'Could not save that income record.');
    }
  }

  function removeIncomeItem(idx) {
    setIncomeItems(prev => prev.filter((_, i) => i !== idx));
  }

  /* ---------------- clean-up tools ---------------- */

  function loadRules() {
    getCategoryRules()
      .then(r => setRules(Array.isArray(r) ? r : []))
      .catch(err => console.error('Rules load failed:', err));
  }

  function loadGaps() {
    setGapsLoading(true);
    getCategorizationGaps()
      .then(g => setGaps(Array.isArray(g) ? g : []))
      .catch(err => console.error('Gaps load failed:', err))
      .finally(() => setGapsLoading(false));
  }

  useEffect(() => {
    if (!toolsOpen || toolsLoaded) return;
    setToolsLoaded(true);
    loadRules();
    loadGaps();
  }, [toolsOpen, toolsLoaded]);

  async function previewRecat() {
    setRecatLoading(true);
    setToolMsg('');
    try {
      const res = (await recategorizeExpenses({ only_uncategorized: true })) || {};
      setRecat({
        scanned: toNumber(res.scanned),
        changes: Array.isArray(res.changes) ? res.changes : [],
        change_count: toNumber(res.change_count),
      });
    } catch (err) {
      setToolMsg((err && err.message) || 'Preview failed.');
    }
    setRecatLoading(false);
  }

  async function applyRecat() {
    setApplying(true);
    setToolMsg('');
    try {
      const res = (await recategorizeExpenses({ only_uncategorized: true, apply: true })) || {};
      setToolMsg(`Applied ${toNumber(res.change_count)} change${toNumber(res.change_count) !== 1 ? 's' : ''} to your existing expenses.`);
      setRecat(null);
      loadGaps();
    } catch (err) {
      setToolMsg((err && err.message) || 'Apply failed.');
    }
    setApplying(false);
  }

  async function saveGapRule(gap, key) {
    const pattern = gap.suggested_pattern || patternFor(gap.description);
    const category = gapCats[key] || 'Groceries';
    if (!pattern) { setToolMsg('No usable pattern for that merchant.'); return; }
    setGapBusy(key);
    try {
      await saveCategoryRule(pattern, category);
      setToolMsg(`Rule saved: "${pattern}" → ${category}. Run the re-categorise preview to apply it to past expenses.`);
      setGaps(prev => prev.filter(g => g !== gap));
      loadRules();
    } catch (err) {
      setToolMsg((err && err.message) || 'Could not save that rule.');
    }
    setGapBusy(null);
  }

  async function handleDeleteRule(rule) {
    if (rule.id == null) return;
    try {
      await deleteCategoryRule(rule.id);
      setRules(prev => prev.filter(r => r.id !== rule.id));
    } catch (err) {
      setToolMsg((err && err.message) || 'Could not delete that rule.');
    }
  }

  /* ---------------- render helpers ---------------- */

  const summary = (meta && meta.summary) || {};
  const rulesHaveIds = rules.some(r => r && r.id != null);

  function StatChip({ label, value, tone }) {
    return (
      <div style={{
        background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8,
        padding: '0.4rem 0.65rem', minWidth: 96, flex: '1 1 auto'
      }}>
        <div style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: tone || 'var(--text)' }}>{value}</div>
      </div>
    );
  }

  const controlRow = { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' };

  /* ---------------- render ---------------- */

  return (
    <div>
      <div className="page-header">
        <h2>Import Transactions</h2>
        <p>Bring in a bank/credit-card CSV or a screenshot of your transactions, check the categories, then import.</p>
      </div>

      {/* -------- input tabs (hidden once there's something to review) -------- */}
      {rows.length === 0 && !imported && (
        <>
          <div className="tabs">
            <button className={`tab ${tab === 'csv' ? 'active' : ''}`} onClick={() => setTab('csv')}>
              <FileText size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />Statement CSV
            </button>
            <button className={`tab ${tab === 'screenshot' ? 'active' : ''}`} onClick={() => setTab('screenshot')}>
              <Camera size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />Screenshots
            </button>
          </div>

          {/* ---- A. CSV ---- */}
          {tab === 'csv' && (
            <div className="card">
              <div className="card-title"><FileText size={14} /> Paste or upload a statement</div>
              <p className="card-sub" style={{ marginTop: 0, marginBottom: '0.85rem' }}>
                Export a CSV from your bank or credit-card provider. The parser auto-detects the delimiter, the
                columns and the header row, categorises each transaction, and pulls salary/refunds out as income.
              </p>

              <div style={{ ...controlRow, marginBottom: '0.85rem' }}>
                <input
                  ref={csvFileRef}
                  type="file"
                  accept=".csv,.txt,.tsv"
                  style={{ display: 'none' }}
                  onChange={e => { readTextFile(e.target.files && e.target.files[0]); if (csvFileRef.current) csvFileRef.current.value = ''; }}
                />
                <button className="btn btn-ghost btn-sm" onClick={() => csvFileRef.current && csvFileRef.current.click()}>
                  <Upload size={14} /> Choose a .csv / .txt / .tsv file
                </button>
                {csvText && (
                  <button className="btn btn-ghost btn-sm" onClick={() => { setCsvText(''); setParseError(''); }}>
                    <X size={14} /> Clear
                  </button>
                )}
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>…or paste below, or drop a file onto the box.</span>
              </div>

              <div className="form-group">
                <label>CSV data</label>
                <textarea
                  className="form-input"
                  rows={12}
                  value={csvText}
                  onChange={e => setCsvText(e.target.value)}
                  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={e => {
                    e.preventDefault();
                    setDragOver(false);
                    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
                    if (f) readTextFile(f);
                  }}
                  placeholder={'Date,Amount,Description\n25/02/2026,45.50,WOOLWORTHS SYDNEY\n25/02/2026,12.00,UBER EATS\n...'}
                  style={{
                    fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical',
                    borderColor: dragOver ? 'var(--accent)' : 'var(--border)',
                    background: dragOver ? 'var(--bg-card-hover)' : 'var(--bg-input)',
                  }}
                />
              </div>

              {parseError && (
                <div className="dupe-warning dupe-exact" style={{ marginBottom: '0.85rem' }}>
                  <AlertTriangle size={14} /> {parseError}
                </div>
              )}

              <button className="btn btn-primary" onClick={handleParse} disabled={!csvText.trim() || parsing}>
                {parsing ? <><div className="spinner" /> Parsing…</> : <><Upload size={16} /> Parse statement</>}
              </button>
            </div>
          )}

          {/* ---- B. Screenshots ---- */}
          {tab === 'screenshot' && (
            <div className="card">
              <div className="card-title"><Camera size={14} /> Import from screenshots</div>
              <p className="card-sub" style={{ marginTop: 0, marginBottom: '0.85rem' }}>
                Screenshot the transaction list in your banking app and upload one or more images. Claude reads them,
                categorises what it finds, and drops the results into the same review table as a CSV import.
              </p>

              <input
                ref={shotFileRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={handleScreenshots}
              />
              <div style={controlRow}>
                <button className="btn btn-primary" onClick={() => shotFileRef.current && shotFileRef.current.click()} disabled={extracting}>
                  {extracting ? <><div className="spinner" /> Reading…</> : <><Camera size={16} /> Choose screenshots</>}
                </button>
                {shotProgress && (
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Image {shotProgress.done} of {shotProgress.total}
                  </span>
                )}
              </div>

              {shotError && (
                <div className="dupe-warning" style={{ marginTop: '0.85rem' }}>
                  <AlertTriangle size={14} /> {shotError}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* -------- parse summary bar -------- */}
      {meta && rows.length > 0 && (
        <div className="card">
          <div className="card-title">
            {meta.kind === 'screenshot' ? <Camera size={14} /> : <FileText size={14} />}
            {meta.kind === 'screenshot' ? 'Screenshots read' : 'Statement parsed'}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <StatChip label="Rows parsed" value={toNumber(summary.parsed) || rows.length} />
            {meta.kind === 'csv' && (
              <StatChip
                label="Date range"
                value={summary.date_from && summary.date_to
                  ? (summary.date_from === summary.date_to ? summary.date_from : `${summary.date_from} → ${summary.date_to}`)
                  : '—'}
              />
            )}
            <StatChip label="Parsed total" value={fmtMoney(summary.total != null ? summary.total : rows.reduce((s, r) => s + toNumber(r.amount), 0))} />
            <StatChip label="Need review" value={reviewCount} tone={reviewCount ? 'var(--yellow)' : undefined} />
            <StatChip label="Transfers" value={transferCount} tone={transferCount ? 'var(--purple)' : undefined} />
            {meta.kind === 'csv' && (
              <StatChip label="Rows skipped" value={toNumber(meta.skipped_rows)} tone={toNumber(meta.skipped_rows) ? 'var(--red)' : undefined} />
            )}
            {meta.kind === 'csv' && toNumber(summary.income) > 0 && (
              <StatChip label="Income rows" value={toNumber(summary.income)} tone="var(--green)" />
            )}
            {meta.kind === 'screenshot' && <StatChip label="Images" value={toNumber(meta.files)} />}
          </div>

          {meta.kind === 'csv' && (
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              Delimiter detected: <strong style={{ color: 'var(--text)' }}>{meta.delimiter === 'tab' ? 'tab' : (meta.delimiter || 'comma')}</strong>
              {' · '}Header row: <strong style={{ color: 'var(--text)' }}>{meta.had_header ? 'found' : 'none — columns inferred from the data'}</strong>
              {toNumber(meta.row_count) > 0 && <> {' · '}{toNumber(meta.row_count)} data rows read</>}
              {toNumber(meta.skipped_rows) > 0 && (
                <>
                  {' · '}
                  <span style={{ color: 'var(--yellow)' }}>
                    {toNumber(meta.skipped_rows)} row{toNumber(meta.skipped_rows) !== 1 ? 's' : ''} skipped — usually an unparseable date (or a zero/blank amount). Check those rows in your export.
                  </span>
                </>
              )}
            </p>
          )}
          {meta.kind === 'screenshot' && toNumber(meta.failed) > 0 && (
            <p style={{ fontSize: '0.78rem', color: 'var(--yellow)' }}>
              {toNumber(meta.failed)} image{toNumber(meta.failed) !== 1 ? 's' : ''} could not be read and {toNumber(meta.failed) !== 1 ? 'were' : 'was'} skipped.
            </p>
          )}
        </div>
      )}

      {/* -------- income detected -------- */}
      {incomeItems.length > 0 && (
        <div className="income-detected">
          <DollarSign size={20} style={{ color: 'var(--green)', flexShrink: 0, marginTop: 2 }} />
          <div className="income-detected-list">
            <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--green)' }}>
              {incomeItems.length} income/credit transaction{incomeItems.length !== 1 ? 's' : ''} detected
            </div>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              These look like salary, refunds or credits, so they've been kept out of your expenses. Save one as an
              income record, move it back to expenses if it was misread, or dismiss it.
            </p>
            {incomeItems.map((item, idx) => (
              <div key={idx} className="income-item" style={{ flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginRight: '0.5rem' }}>{item && item.expense_date}</span>
                <span className="income-item-desc">
                  {(item && item.description) || '(no description)'}
                  {item && item.reason && (
                    <span style={{ marginLeft: '0.4rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      ({item.reason === 'credit' ? 'credit amount' : 'matched wording'})
                    </span>
                  )}
                </span>
                <span className="income-item-amount">{fmtMoney(item && item.amount)}</span>
                <div className="income-item-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => saveIncomeRecord(idx)} title="Save as an income record">
                    <DollarSign size={12} /> Income
                  </button>
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

      {/* -------- shared review table -------- */}
      {rows.length > 0 && (
        <div>
          {checking && (
            <div className="card" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div className="spinner" /> Checking for duplicates…
            </div>
          )}

          <div className="card">
            <div className="card-title">Review — {rows.length} transaction{rows.length !== 1 ? 's' : ''}</div>
            <p className="card-sub" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
              {included.length} of {rows.length} rows will be imported, totalling <strong style={{ color: 'var(--text)' }}>{fmtMoney(total)}</strong>.
              Edit anything that's wrong, then import.
            </p>

            {transferCount > 0 && (
              <div className="dupe-warning" style={{ marginBottom: '0.5rem' }}>
                <AlertTriangle size={14} />
                {transferCount} row{transferCount !== 1 ? 's look' : ' looks'} like a transfer between your own accounts. That isn't spending, so
                {transferCount !== 1 ? " they're" : " it's"} excluded by default — click Include if you do want {transferCount !== 1 ? 'them' : 'it'}.
              </div>
            )}
            {dupeCount > 0 && (
              <div className="dupe-warning dupe-exact" style={{ marginBottom: '0.5rem' }}>
                <AlertTriangle size={14} />
                {dupeCount} likely duplicate{dupeCount !== 1 ? 's' : ''} auto-excluded. Click Include to import anyway.
              </div>
            )}
            {reviewCount > 0 && (
              <div className="dupe-warning" style={{ marginBottom: '0.75rem' }}>
                <AlertTriangle size={14} />
                {reviewCount} row{reviewCount !== 1 ? 's need' : ' needs'} a look — the categoriser wasn't confident. They're still included; fix the category, or teach a rule with "Always".
              </div>
            )}

            {/* bulk actions */}
            <div style={{ ...controlRow, padding: '0.6rem', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: '0.85rem' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
                {selected.size} selected
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set(visible.map(r => r._id)))}>
                Select all{onlyReview ? ' shown' : ''}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Select none</button>

              <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)' }} />

              <select
                className="form-select"
                value={bulkCategory}
                onChange={e => setBulkCategory(e.target.value)}
                style={{ width: 'auto', minWidth: 130, fontSize: '0.78rem', padding: '0.3rem 0.5rem', borderLeft: `3px solid ${getCategoryColor(bulkCategory)}` }}
              >
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <button className="btn btn-primary btn-sm" disabled={!selected.size} onClick={() => setCategoryFor(selected, bulkCategory)}>
                <Tag size={13} /> Set category
              </button>
              <button className="btn btn-ghost btn-sm" disabled={!selected.size} onClick={() => setExcludedFor(selected, false)}>Include</button>
              <button className="btn btn-ghost btn-sm" disabled={!selected.size} onClick={() => setExcludedFor(selected, true)}>Exclude</button>

              <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)' }} />

              <button
                className={`btn btn-sm ${onlyReview ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setOnlyReview(v => !v)}
              >
                <Filter size={13} /> {onlyReview ? `Showing ${visible.length} needing review` : `Only needs review (${reviewCount})`}
              </button>
            </div>

            {ruleMsg && (
              <div className="success-msg" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.85rem', fontSize: '0.8rem' }}>
                <Check size={14} /> {ruleMsg}
              </div>
            )}

            {/* running totals by category */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '1rem' }}>
              {Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => (
                <span key={cat} className="tag" style={{ fontSize: '0.72rem', background: `${getCategoryColor(cat)}22`, color: getCategoryColor(cat) }}>
                  {cat}: {fmtMoney(amt)}
                </span>
              ))}
              {!included.length && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>No rows included yet.</span>}
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 34 }}><span className="sr-only">Select</span></th>
                    <th style={{ width: 34 }}>In</th>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Amount</th>
                    <th>Category</th>
                    <th>Confidence</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(r => {
                    const dupe = dupes[r._id] || {};
                    const isExcluded = excluded.has(r._id);
                    const exact = Array.isArray(dupe.exact_matches) ? dupe.exact_matches : [];
                    const near = Array.isArray(dupe.near_matches) ? dupe.near_matches : [];
                    const wasDeleted = !!dupe.was_deleted;
                    const flagged = r.needs_review || r.is_transfer || r.confidence === 'low';
                    const accent = r.is_transfer ? 'var(--purple)' : (flagged ? 'var(--yellow)' : 'transparent');
                    const pattern = patternFor(r.description);
                    return (
                      <tr
                        key={r._id}
                        className={isExcluded ? 'dupe-row excluded' : (exact.length || wasDeleted ? 'dupe-row' : '')}
                        style={flagged && !isExcluded ? { background: r.is_transfer ? 'var(--purple-bg)' : 'var(--yellow-bg)' } : undefined}
                      >
                        <td style={{ borderLeft: `3px solid ${accent}` }}>
                          <input
                            type="checkbox"
                            checked={selected.has(r._id)}
                            onChange={() => toggleSelect(r._id)}
                            aria-label="Select row"
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={!isExcluded}
                            onChange={() => toggleExclude(r._id)}
                            aria-label="Include in import"
                            title={isExcluded ? 'Excluded from import' : 'Included in import'}
                          />
                        </td>
                        <td>
                          <input
                            className="form-input"
                            value={r.expense_date}
                            onChange={e => updateRow(r._id, 'expense_date', e.target.value)}
                            style={{ fontSize: '0.78rem', padding: '0.25rem 0.4rem', width: 108 }}
                          />
                        </td>
                        <td>
                          <input
                            className="form-input"
                            value={r.description}
                            onChange={e => updateRow(r._id, 'description', e.target.value)}
                            style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem', minWidth: 180 }}
                          />
                        </td>
                        <td>
                          <input
                            className="form-input"
                            type="number"
                            step="0.01"
                            value={r.amount}
                            onChange={e => updateRow(r._id, 'amount', toNumber(e.target.value))}
                            style={{ fontSize: '0.8rem', padding: '0.25rem 0.4rem', width: 96, fontWeight: 600 }}
                          />
                        </td>
                        <td>
                          <select
                            className="form-select"
                            value={r.category}
                            onChange={e => setCategoryFor([r._id], e.target.value)}
                            style={{
                              fontSize: '0.78rem', padding: '0.25rem 0.4rem', minWidth: 124,
                              borderLeft: `3px solid ${getCategoryColor(r.category)}`,
                            }}
                          >
                            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <span
                            className={`tag ${CONF_TAG[r.confidence] || 'tag-blue'}`}
                            title={r.matched ? `Matched on "${r.matched}"` : 'No keyword matched'}
                          >
                            {r.confidence || 'medium'}
                          </span>
                          {r.matched && (
                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 2 }}>“{r.matched}”</div>
                          )}
                        </td>
                        <td style={{ minWidth: 150 }}>
                          {r.is_transfer && (
                            <div className="dupe-warning dupe-deleted" style={{ marginBottom: '0.2rem' }}>Looks like a transfer</div>
                          )}
                          {exact.length > 0 && (
                            <div className="dupe-warning dupe-exact" style={{ marginBottom: '0.2rem' }}>
                              Duplicate — {exact.map(m => (m && (m.description || m.category)) || 'existing expense').join(', ')}
                            </div>
                          )}
                          {exact.length === 0 && near.length > 0 && (
                            <div className="dupe-warning" style={{ marginBottom: '0.2rem' }}>
                              Similar — {(near[0] && near[0].description) || 'existing expense'} ({fmtMoney(near[0] && near[0].amount)})
                            </div>
                          )}
                          {wasDeleted && (
                            <div className="dupe-warning dupe-deleted" style={{ marginBottom: '0.2rem' }}>Previously deleted</div>
                          )}
                          {!r.is_transfer && exact.length === 0 && near.length === 0 && !wasDeleted && (
                            <span className="tag tag-green">New</span>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center', flexWrap: 'wrap' }}>
                            <button className="dupe-toggle" onClick={() => toggleExclude(r._id)}>
                              {isExcluded ? 'Include' : 'Exclude'}
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              disabled={!pattern || ruleBusyId === r._id}
                              onClick={() => handleAlwaysCategorize(r)}
                              title={pattern ? `Always categorise "${pattern}" as ${r.category}` : 'Description too short for a rule'}
                            >
                              {ruleBusyId === r._id ? <div className="spinner" /> : <Wand2 size={13} />} Always
                            </button>
                            <button className="btn btn-ghost btn-sm" onClick={() => removeRow(r._id)} title="Remove this row">
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={9} style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                        Nothing needs review — clear the filter to see all {rows.length} rows.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="btn-group" style={{ marginBottom: '1rem' }}>
            <button className="btn btn-success" onClick={handleImport} disabled={importing || !included.length}>
              {importing ? <><div className="spinner" /> Importing…</> : <><CheckCircle size={16} /> Import {included.length} transaction{included.length !== 1 ? 's' : ''} ({fmtMoney(total)})</>}
            </button>
            <button className="btn btn-ghost" onClick={resetReview} disabled={importing}>Cancel</button>
          </div>
        </div>
      )}

      {/* -------- success -------- */}
      {imported && (
        <div className="card">
          <div className="success-msg" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <CheckCircle size={20} /> Imported {importCount} transaction{importCount !== 1 ? 's' : ''} as expenses.
          </div>
          <p className="card-sub" style={{ marginTop: 0, marginBottom: '1rem' }}>
            They're in your expense history now, so they'll show up on the Dashboard, in budget tracking and in Claude's analysis.
            {importNote ? ` ${importNote}` : ''}
          </p>
          <div className="btn-group">
            <button className="btn btn-primary" onClick={() => { setImported(false); setTab('csv'); }}>
              <Upload size={16} /> Import another statement
            </button>
            <button className="btn btn-ghost" onClick={() => { setImported(false); setTab('screenshot'); }}>
              <Camera size={16} /> Import screenshots
            </button>
          </div>
        </div>
      )}

      {/* -------- C. Clean-up tools -------- */}
      <div className="card">
        <button
          className="btn btn-ghost"
          onClick={() => setToolsOpen(v => !v)}
          style={{ width: '100%', justifyContent: 'flex-start', border: 'none', padding: 0 }}
        >
          {toolsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span style={{ fontWeight: 600 }}>Categorisation clean-up</span>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontWeight: 400 }}>
            — fix past expenses and teach the categoriser
          </span>
        </button>

        {toolsOpen && (
          <div style={{ marginTop: '1rem' }}>
            {toolMsg && (
              <div className="dupe-warning" style={{ marginBottom: '1rem' }}>
                <AlertTriangle size={14} /> {toolMsg}
              </div>
            )}

            {/* --- re-categorise --- */}
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.85rem', marginBottom: '1rem' }}>
              <div className="card-title" style={{ marginBottom: '0.4rem' }}><RefreshCw size={14} /> Re-categorise existing expenses</div>
              <p className="card-sub" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
                Re-runs the categoriser over everything currently sitting in <strong style={{ color: 'var(--text)' }}>Other</strong>.
                Preview changes nothing — it only shows what would change. Nothing is written until you press Apply.
              </p>
              <div style={controlRow}>
                <button className="btn btn-ghost btn-sm" onClick={previewRecat} disabled={recatLoading}>
                  {recatLoading ? <><div className="spinner" /> Scanning…</> : <><RefreshCw size={13} /> Preview changes</>}
                </button>
                {recat && recat.changes.length > 0 && (
                  <button className="btn btn-success btn-sm" onClick={applyRecat} disabled={applying}>
                    {applying ? <><div className="spinner" /> Applying…</> : <><Check size={13} /> Apply {recat.changes.length} change{recat.changes.length !== 1 ? 's' : ''}</>}
                  </button>
                )}
              </div>

              {recat && (
                <div style={{ marginTop: '0.85rem' }}>
                  <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                    Scanned {recat.scanned} expense{recat.scanned !== 1 ? 's' : ''} · {recat.changes.length} would change. Preview only — nothing saved yet.
                  </p>
                  {recat.changes.length > 0 && (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Date</th><th>Description</th><th>Amount</th><th>From → To</th><th>Matched</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recat.changes.map((c, i) => (
                            <tr key={(c && c.id) != null ? c.id : i}>
                              <td style={{ whiteSpace: 'nowrap', fontSize: '0.78rem' }}>{c && c.expense_date}</td>
                              <td style={{ fontSize: '0.8rem' }}>{(c && c.description) || '—'}</td>
                              <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{fmtMoney(c && c.amount)}</td>
                              <td style={{ whiteSpace: 'nowrap' }}>
                                <span className="tag" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>{(c && c.from) || 'Other'}</span>
                                <ArrowRight size={12} style={{ margin: '0 0.3rem', verticalAlign: '-2px', color: 'var(--text-muted)' }} />
                                <span className="tag" style={{ background: `${getCategoryColor(c && c.to)}22`, color: getCategoryColor(c && c.to) }}>{(c && c.to) || 'Other'}</span>
                              </td>
                              <td style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                {c && c.matched ? `“${c.matched}”` : '—'}
                                {c && c.confidence ? ` · ${c.confidence}` : ''}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* --- gaps --- */}
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.85rem', marginBottom: '1rem' }}>
              <div className="card-title" style={{ marginBottom: '0.4rem' }}><AlertTriangle size={14} /> Merchants stuck in "Other"</div>
              <p className="card-sub" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
                These keep landing in Other, so they're the highest-value rules to teach. Pick a category and save the rule —
                then run the preview above to fix the past ones.
              </p>
              <div style={{ ...controlRow, marginBottom: '0.75rem' }}>
                <button className="btn btn-ghost btn-sm" onClick={loadGaps} disabled={gapsLoading}>
                  {gapsLoading ? <><div className="spinner" /> Loading…</> : <><RefreshCw size={13} /> Refresh</>}
                </button>
              </div>
              {gaps.length === 0 && !gapsLoading && (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Nothing stuck in Other right now.</p>
              )}
              {gaps.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Merchant</th><th>Count</th><th>Total</th><th>Last seen</th><th>Rule</th></tr>
                    </thead>
                    <tbody>
                      {gaps.map((g, i) => {
                        const key = (g && g.suggested_pattern) || `gap-${i}`;
                        const cat = gapCats[key] || 'Groceries';
                        return (
                          <tr key={key}>
                            <td style={{ fontSize: '0.8rem' }}>
                              {(g && g.description) || '—'}
                              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                pattern: “{(g && g.suggested_pattern) || patternFor(g && g.description)}”
                              </div>
                            </td>
                            <td style={{ whiteSpace: 'nowrap' }}>{toNumber(g && g.count)}</td>
                            <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{fmtMoney(g && g.total)}</td>
                            <td style={{ whiteSpace: 'nowrap', fontSize: '0.78rem', color: 'var(--text-muted)' }}>{(g && g.last_seen) || '—'}</td>
                            <td>
                              <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                <select
                                  className="form-select"
                                  value={cat}
                                  onChange={e => setGapCats(prev => ({ ...prev, [key]: e.target.value }))}
                                  style={{ width: 'auto', minWidth: 120, fontSize: '0.78rem', padding: '0.25rem 0.4rem', borderLeft: `3px solid ${getCategoryColor(cat)}` }}
                                >
                                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                                <button className="btn btn-primary btn-sm" disabled={gapBusy === key} onClick={() => saveGapRule(g, key)}>
                                  {gapBusy === key ? <div className="spinner" /> : <Save size={13} />} Save rule
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* --- learned rules --- */}
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.85rem' }}>
              <div className="card-title" style={{ marginBottom: '0.4rem' }}><Tag size={14} /> Learned rules ({rules.length})</div>
              <p className="card-sub" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
                Every description containing one of these patterns gets that category automatically, on every future import.
              </p>
              {rules.length === 0 && (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>No rules yet. Use "Always" on a row above, or teach one from the list of merchants stuck in Other.</p>
              )}
              {rules.length > 0 && (
                <>
                  {!rulesHaveIds && (
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                      The rules endpoint doesn't return row ids, so rules can't be deleted from here yet. Saving a rule with
                      the same pattern overwrites its category.
                    </p>
                  )}
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Pattern</th><th>Category</th><th></th></tr></thead>
                      <tbody>
                        {rules.map((rule, i) => (
                          <tr key={(rule && rule.id) != null ? rule.id : `${(rule && rule.supplier_pattern) || 'rule'}-${i}`}>
                            <td style={{ fontSize: '0.8rem', fontFamily: 'monospace' }}>{(rule && rule.supplier_pattern) || '—'}</td>
                            <td>
                              <span className="tag" style={{ background: `${getCategoryColor(rule && rule.category)}22`, color: getCategoryColor(rule && rule.category) }}>
                                {(rule && rule.category) || 'Other'}
                              </span>
                            </td>
                            <td style={{ width: 40 }}>
                              {rule && rule.id != null && (
                                <button className="btn btn-ghost btn-sm" onClick={() => handleDeleteRule(rule)} title="Delete rule">
                                  <Trash2 size={13} />
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
