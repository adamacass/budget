import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getBalances, updateBalance, exportToExcel, downloadBackup, restoreBackup, getCategoryRules, deleteCategoryRule } from '../api';
import { Save, Download, Key, User, DollarSign, Database, Upload, Smartphone, Tag, Trash2, Copy } from 'lucide-react';
import { CATEGORIES, getCategoryColor } from '../categoryColors';

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export default function Settings() {
  const { user, updateProfile, changePassword } = useAuth();
  const [tab, setTab] = useState('profile');
  const [balances, setBalances] = useState({});

  // Profile form
  const [profile, setProfile] = useState({
    display_name: user?.display_name || '',
    gross_income: user?.gross_income || '',
    super_rate: ((user?.super_rate || 0.115) * 100).toFixed(1),
    hecs_repayment_rate: ((user?.hecs_repayment_rate || 0) * 100).toFixed(1),
    pay_cycle: user?.pay_cycle || 'fortnightly'
  });
  const [profileMsg, setProfileMsg] = useState('');

  // Password form
  const [passwords, setPasswords] = useState({ current: '', new1: '', new2: '' });
  const [pwMsg, setPwMsg] = useState('');

  // Export form
  const [exportRange, setExportRange] = useState({
    start: new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0]
  });

  // Category rules
  const [rules, setRules] = useState([]);
  const [rulesLoading, setRulesLoading] = useState(false);

  useEffect(() => {
    getBalances().then(setBalances).catch(console.error);
  }, []);

  useEffect(() => {
    if (tab === 'rules') {
      setRulesLoading(true);
      getCategoryRules().then(setRules).catch(console.error).finally(() => setRulesLoading(false));
    }
  }, [tab]);

  async function handleDeleteRule(id) {
    try {
      await deleteCategoryRule(id);
      setRules(prev => prev.filter(r => r.id !== id));
    } catch (err) { alert(err.message); }
  }

  async function handleSaveProfile(e) {
    e.preventDefault();
    try {
      await updateProfile({
        display_name: profile.display_name,
        gross_income: parseFloat(profile.gross_income),
        super_rate: parseFloat(profile.super_rate) / 100,
        hecs_repayment_rate: parseFloat(profile.hecs_repayment_rate) / 100,
        pay_cycle: profile.pay_cycle
      });
      setProfileMsg('Profile updated!');
      setTimeout(() => setProfileMsg(''), 3000);
    } catch (err) { setProfileMsg('Error: ' + err.message); }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    if (passwords.new1 !== passwords.new2) { setPwMsg('Passwords do not match'); return; }
    try {
      await changePassword(passwords.current, passwords.new1);
      setPwMsg('Password changed!');
      setPasswords({ current: '', new1: '', new2: '' });
      setTimeout(() => setPwMsg(''), 3000);
    } catch (err) { setPwMsg('Error: ' + err.message); }
  }

  async function handleUpdateBalance(account) {
    try {
      await updateBalance(account, balances[account]);
    } catch (err) { alert(err.message); }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Settings</h2>
        <p>Manage your profile, accounts, and exports</p>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'profile' ? 'active' : ''}`} onClick={() => setTab('profile')}>
          <User size={14} style={{ marginRight: 4 }} /> Profile & Income
        </button>
        <button className={`tab ${tab === 'accounts' ? 'active' : ''}`} onClick={() => setTab('accounts')}>
          <DollarSign size={14} style={{ marginRight: 4 }} /> Account Balances
        </button>
        <button className={`tab ${tab === 'security' ? 'active' : ''}`} onClick={() => setTab('security')}>
          <Key size={14} style={{ marginRight: 4 }} /> Security
        </button>
        <button className={`tab ${tab === 'export' ? 'active' : ''}`} onClick={() => setTab('export')}>
          <Download size={14} style={{ marginRight: 4 }} /> Export
        </button>
        <button className={`tab ${tab === 'backup' ? 'active' : ''}`} onClick={() => setTab('backup')}>
          <Database size={14} style={{ marginRight: 4 }} /> Backup
        </button>
        <button className={`tab ${tab === 'rules' ? 'active' : ''}`} onClick={() => setTab('rules')}>
          <Tag size={14} style={{ marginRight: 4 }} /> Category Rules
        </button>
        <button className={`tab ${tab === 'widget' ? 'active' : ''}`} onClick={() => setTab('widget')}>
          <Smartphone size={14} style={{ marginRight: 4 }} /> iPhone Widget
        </button>
      </div>

      {tab === 'profile' && (
        <div className="card">
          <div className="card-title">Profile & Income Settings</div>
          {profileMsg && <div className={profileMsg.startsWith('Error') ? 'error-msg' : 'success-msg'}>{profileMsg}</div>}
          <form onSubmit={handleSaveProfile}>
            <div className="form-row">
              <div className="form-group">
                <label>Display Name</label>
                <input className="form-input" value={profile.display_name} onChange={e => setProfile({ ...profile, display_name: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Pay Cycle</label>
                <select className="form-select" value={profile.pay_cycle} onChange={e => setProfile({ ...profile, pay_cycle: e.target.value })}>
                  <option value="weekly">Weekly</option>
                  <option value="fortnightly">Fortnightly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Gross Income (p.a. incl. super)</label>
                <input className="form-input" type="number" value={profile.gross_income} onChange={e => setProfile({ ...profile, gross_income: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Super Rate (%)</label>
                <input className="form-input" type="number" step="0.1" value={profile.super_rate} onChange={e => setProfile({ ...profile, super_rate: e.target.value })} />
              </div>
              <div className="form-group">
                <label>HECS Repayment Rate (%)</label>
                <input className="form-input" type="number" step="0.1" value={profile.hecs_repayment_rate} onChange={e => setProfile({ ...profile, hecs_repayment_rate: e.target.value })} />
              </div>
            </div>

            {/* Income breakdown */}
            <div className="card" style={{ background: 'var(--bg-input)', marginTop: '0.5rem' }}>
              <div className="card-title">Estimated Income Breakdown</div>
              {(() => {
                const gross = parseFloat(profile.gross_income) || 0;
                const superRate = parseFloat(profile.super_rate) / 100 || 0.115;
                const hecsRate = parseFloat(profile.hecs_repayment_rate) / 100 || 0;
                const grossExSuper = gross / (1 + superRate);
                const superAmt = gross - grossExSuper;
                let tax = 0;
                if (grossExSuper > 190000) tax = 51667 + (grossExSuper - 190000) * 0.45;
                else if (grossExSuper > 135000) tax = 29467 + (grossExSuper - 135000) * 0.37;
                else if (grossExSuper > 45000) tax = 5092 + (grossExSuper - 45000) * 0.325;
                else if (grossExSuper > 18200) tax = (grossExSuper - 18200) * 0.19;
                const hecs = grossExSuper * hecsRate;
                const annualNet = grossExSuper - tax - hecs;
                const periods = profile.pay_cycle === 'weekly' ? 52 : profile.pay_cycle === 'fortnightly' ? 26 : 12;
                return (
                  <div style={{ fontSize: '0.85rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                    <span>Gross (incl. super):</span><span style={{ fontWeight: 600 }}>{fmtMoney(gross)}</span>
                    <span>Super ({(superRate*100).toFixed(1)}%):</span><span>{fmtMoney(superAmt)}</span>
                    <span>Taxable income:</span><span>{fmtMoney(grossExSuper)}</span>
                    <span>Estimated tax:</span><span style={{ color: 'var(--red)' }}>-{fmtMoney(tax)}</span>
                    <span>HECS ({(hecsRate*100).toFixed(1)}%):</span><span style={{ color: 'var(--red)' }}>-{fmtMoney(hecs)}</span>
                    <span style={{ fontWeight: 700 }}>Annual net:</span><span style={{ fontWeight: 700, color: 'var(--green)' }}>{fmtMoney(annualNet)}</span>
                    <span style={{ fontWeight: 700 }}>Per {profile.pay_cycle} period:</span><span style={{ fontWeight: 700, color: 'var(--green)' }}>{fmtMoney(annualNet / periods)}</span>
                  </div>
                );
              })()}
            </div>

            <button className="btn btn-primary" type="submit" style={{ marginTop: '1rem' }}>
              <Save size={14} /> Save Profile
            </button>
          </form>
        </div>
      )}

      {tab === 'accounts' && (
        <div className="card">
          <div className="card-title">Manual Balance Corrections</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Update account balances manually to match your actual bank statements.
          </p>
          {['offset', 'savings', 'credit_card', 'investment'].map(acct => (
            <div key={acct} style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
              <div style={{ width: 150, fontWeight: 600, fontSize: '0.9rem', textTransform: 'capitalize' }}>
                {acct.replace('_', ' ')}
              </div>
              <input className="form-input" type="number" step="0.01" style={{ width: 200 }}
                value={balances[acct] || ''}
                onChange={e => setBalances({ ...balances, [acct]: parseFloat(e.target.value) || 0 })}
              />
              <button className="btn btn-success btn-sm" onClick={() => handleUpdateBalance(acct)}>
                <Save size={14} /> Update
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'security' && (
        <div className="card">
          <div className="card-title">Change Password</div>
          {pwMsg && <div className={pwMsg.startsWith('Error') ? 'error-msg' : 'success-msg'}>{pwMsg}</div>}
          <form onSubmit={handleChangePassword}>
            <div className="form-group">
              <label>Current Password</label>
              <input className="form-input" type="password" value={passwords.current}
                onChange={e => setPasswords({ ...passwords, current: e.target.value })} required />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>New Password</label>
                <input className="form-input" type="password" value={passwords.new1}
                  onChange={e => setPasswords({ ...passwords, new1: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Confirm New Password</label>
                <input className="form-input" type="password" value={passwords.new2}
                  onChange={e => setPasswords({ ...passwords, new2: e.target.value })} required />
              </div>
            </div>
            <button className="btn btn-primary" type="submit"><Key size={14} /> Change Password</button>
          </form>
        </div>
      )}

      {tab === 'export' && (
        <div className="card">
          <div className="card-title">Export to Excel</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Download all expenses, income, goals, and balances as an Excel spreadsheet.
          </p>
          <div className="form-row">
            <div className="form-group">
              <label>From</label>
              <input className="form-input" type="date" value={exportRange.start}
                onChange={e => setExportRange({ ...exportRange, start: e.target.value })} />
            </div>
            <div className="form-group">
              <label>To</label>
              <input className="form-input" type="date" value={exportRange.end}
                onChange={e => setExportRange({ ...exportRange, end: e.target.value })} />
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => exportToExcel(exportRange)}>
            <Download size={14} /> Download Excel
          </button>
        </div>
      )}

      {tab === 'backup' && (
        <div className="card">
          <div className="card-title"><Database size={14} /> Data Backup & Restore</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Download a full JSON backup of all your data, or restore from a previous backup.
          </p>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={async () => {
              try { await downloadBackup(); } catch (err) { alert('Backup failed: ' + err.message); }
            }}>
              <Download size={14} /> Download Backup
            </button>
            <label className="btn btn-success" style={{ cursor: 'pointer' }}>
              <Upload size={14} /> Restore from Backup
              <input type="file" accept=".json" style={{ display: 'none' }} onChange={async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                try {
                  const text = await file.text();
                  const backup = JSON.parse(text);
                  if (!backup.expenses) { alert('Invalid backup file'); return; }
                  if (!confirm(`Restore ${backup.expenses.length} expenses from backup dated ${backup.exported_at || 'unknown'}? Existing data will not be overwritten.`)) return;
                  const result = await restoreBackup(backup);
                  alert(`Restored ${result.restored} new expenses (${result.total_in_backup} total in backup)`);
                } catch (err) { alert('Restore failed: ' + err.message); }
                e.target.value = '';
              }} />
            </label>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '1rem' }}>
            We recommend downloading a backup regularly to protect against data loss.
          </p>
        </div>
      )}

      {tab === 'rules' && (
        <div className="card">
          <div className="card-title"><Tag size={14} /> Learned Category Rules</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            When you categorise a transaction, the app learns to auto-categorise future transactions from the same supplier.
            These rules are applied when parsing new statements or screenshots.
          </p>
          {rulesLoading ? (
            <div style={{ textAlign: 'center', padding: '1rem' }}><div className="spinner" /></div>
          ) : rules.length === 0 ? (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              No learned rules yet. Categorise transactions in Expenses or Speed Run mode and rules will appear here.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Supplier Pattern</th>
                    <th>Category</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map(r => (
                    <tr key={r.id}>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{r.supplier_pattern}</td>
                      <td>
                        <span className="tag" style={{ background: `${getCategoryColor(r.category)}22`, color: getCategoryColor(r.category) }}>
                          {r.category}
                        </span>
                      </td>
                      <td>
                        <button className="btn btn-ghost btn-sm" onClick={() => handleDeleteRule(r.id)} title="Delete rule">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'widget' && (
        <div className="card">
          <div className="card-title"><Smartphone size={14} /> iPhone Widget (Scriptable)</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Add a budget widget to your iPhone home screen using the free <strong>Scriptable</strong> app.
          </p>

          <div style={{ marginBottom: '1rem' }}>
            <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Setup Instructions</h4>
            <ol style={{ fontSize: '0.82rem', lineHeight: 1.8, paddingLeft: '1.25rem', color: 'var(--text-muted)' }}>
              <li>Install <strong>Scriptable</strong> from the App Store</li>
              <li>Open Scriptable, tap <strong>+</strong> to create a new script</li>
              <li>Paste the code below</li>
              <li>Update <code>BASE_URL</code> to your app's URL and <code>TOKEN</code> with your auth token</li>
              <li>Run the script once to test it</li>
              <li>Go to your home screen, long-press → Add Widget → Scriptable</li>
              <li>Choose <strong>Medium</strong> size, then tap the widget to select your script</li>
            </ol>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Your Auth Token</h4>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <code style={{ fontSize: '0.7rem', padding: '0.5rem', background: 'var(--bg-input)', borderRadius: 6, wordBreak: 'break-all', flex: 1 }}>
                {localStorage.getItem('token')?.substring(0, 40)}...
              </code>
              <button className="btn btn-ghost btn-sm" onClick={() => {
                navigator.clipboard.writeText(localStorage.getItem('token') || '');
                alert('Token copied to clipboard');
              }}>
                <Copy size={14} /> Copy
              </button>
            </div>
          </div>

          <div style={{ marginBottom: '0.5rem' }}>
            <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Scriptable Code</h4>
            <button className="btn btn-ghost btn-sm" style={{ marginBottom: '0.5rem' }} onClick={() => {
              const code = document.getElementById('scriptable-code')?.textContent || '';
              navigator.clipboard.writeText(code);
              alert('Code copied to clipboard');
            }}>
              <Copy size={14} /> Copy Code
            </button>
          </div>
          <pre id="scriptable-code" style={{ fontSize: '0.65rem', lineHeight: 1.5, padding: '1rem', background: 'var(--bg-input)', borderRadius: 8, overflow: 'auto', maxHeight: 400, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{`// Budget Widget for Scriptable
// Shows daily/weekly/monthly spending, budget pace, and per-user activity

const BASE_URL = "${window.location.origin}";
const TOKEN = "PASTE_YOUR_TOKEN_HERE";

async function fetchWidget() {
  const req = new Request(BASE_URL + "/api/widget");
  req.headers = { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" };
  return await req.loadJSON();
}

function fmt(n) { return "$" + Math.round(n).toLocaleString(); }

function timeAgo(dateStr) {
  if (!dateStr) return "Never";
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  return days + "d ago";
}

try {
  const d = await fetchWidget();
  const w = new ListWidget();
  w.backgroundColor = new Color("#0f1117");
  w.setPadding(12, 14, 12, 14);

  // Title row
  const titleStack = w.addStack();
  titleStack.layoutHorizontally();
  titleStack.centerAlignContent();
  const corgi = titleStack.addText(d.under_budget ? "\\u{1F436}" : "\\u{1F61E}");
  corgi.font = Font.systemFont(14);
  titleStack.addSpacer(4);
  const title = titleStack.addText("Budget Tracker");
  title.font = Font.boldSystemFont(13);
  title.textColor = new Color("#e8eaf0");
  titleStack.addSpacer();
  const paceText = titleStack.addText(d.pace_percent + "%");
  paceText.font = Font.boldSystemFont(13);
  paceText.textColor = d.under_budget ? new Color("#00cec9") : new Color("#ff6b6b");

  w.addSpacer(6);

  // Spending row
  const spendStack = w.addStack();
  spendStack.layoutHorizontally();
  const cols = [
    { label: "Today", value: fmt(d.today_spent), color: "#e8eaf0" },
    { label: "Week", value: fmt(d.week_spent), color: "#54a0ff" },
    { label: "Month", value: fmt(d.month_spent), color: "#6c5ce7" },
    { label: "Budget", value: fmt(d.monthly_budget), color: "#00cec9" },
  ];
  for (const col of cols) {
    const c = spendStack.addStack();
    c.layoutVertically();
    const lbl = c.addText(col.label);
    lbl.font = Font.systemFont(9);
    lbl.textColor = new Color("#8b8fa3");
    const val = c.addText(col.value);
    val.font = Font.boldSystemFont(12);
    val.textColor = new Color(col.color);
    spendStack.addSpacer();
  }

  w.addSpacer(6);

  // Progress bar
  const barStack = w.addStack();
  barStack.layoutHorizontally();
  barStack.cornerRadius = 3;
  barStack.size = new Size(0, 6);
  barStack.backgroundColor = new Color("#2d3148");
  const fillWidth = Math.min(d.pace_percent, 100);
  const fillColor = d.pace_percent <= 90 ? "#00cec9" : d.pace_percent <= 100 ? "#feca57" : "#ff6b6b";
  const barCtx = new DrawContext();
  barCtx.size = new Size(300, 6);
  barCtx.opaque = false;
  barCtx.setFillColor(new Color("#2d3148"));
  barCtx.fillRect(new Rect(0, 0, 300, 6));
  barCtx.setFillColor(new Color(fillColor));
  barCtx.fillRect(new Rect(0, 0, fillWidth * 3, 6));
  const barImg = w.addImage(barCtx.getImage());
  barImg.cornerRadius = 3;
  barImg.imageSize = new Size(0, 6);

  w.addSpacer(6);

  // Per-user activity
  for (const u of d.users) {
    const uStack = w.addStack();
    uStack.layoutHorizontally();
    uStack.centerAlignContent();
    const nameColor = u.name.toLowerCase().includes("adam") ? "#6c5ce7" : "#00cec9";
    const dot = uStack.addText("\\u25CF ");
    dot.font = Font.systemFont(10);
    dot.textColor = new Color(nameColor);
    const nm = uStack.addText(u.name);
    nm.font = Font.mediumSystemFont(10);
    nm.textColor = new Color("#e8eaf0");
    uStack.addSpacer(4);
    const amt = uStack.addText(fmt(u.month_total));
    amt.font = Font.systemFont(10);
    amt.textColor = new Color("#8b8fa3");
    uStack.addSpacer();
    const lastAdded = uStack.addText(timeAgo(u.last_added_at));
    lastAdded.font = Font.systemFont(9);
    lastAdded.textColor = u.days_since_last !== null && u.days_since_last <= 1
      ? new Color("#00cec9") : new Color("#ff6b6b");
  }

  w.addSpacer(4);

  // Top categories
  const catStack = w.addStack();
  catStack.layoutHorizontally();
  for (const cat of d.top_categories.slice(0, 3)) {
    const cs = catStack.addStack();
    cs.layoutHorizontally();
    cs.centerAlignContent();
    cs.setPadding(2, 6, 2, 6);
    cs.cornerRadius = 4;
    cs.backgroundColor = new Color("#1a1d27");
    const ct = cs.addText(cat.category.substring(0, 6) + " " + fmt(cat.total));
    ct.font = Font.systemFont(8);
    ct.textColor = new Color("#8b8fa3");
    catStack.addSpacer(4);
  }

  if (config.runsInWidget) {
    Script.setWidget(w);
  } else {
    await w.presentMedium();
  }
} catch (e) {
  const w = new ListWidget();
  w.backgroundColor = new Color("#0f1117");
  const err = w.addText("Error: " + e.message);
  err.font = Font.systemFont(11);
  err.textColor = new Color("#ff6b6b");
  if (config.runsInWidget) Script.setWidget(w);
  else await w.presentMedium();
}

Script.complete();`}</pre>
        </div>
      )}
    </div>
  );
}
