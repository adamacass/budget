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
        <button className={`tab ${tab === 'shortcuts' ? 'active' : ''}`} onClick={() => setTab('shortcuts')}>
          <Smartphone size={14} style={{ marginRight: 4 }} /> iOS Shortcuts
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
            Add a beautiful budget widget with corgi mascot to your iPhone home screen using the free <strong>Scriptable</strong> app.
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
          <pre id="scriptable-code" style={{ fontSize: '0.65rem', lineHeight: 1.5, padding: '1rem', background: 'var(--bg-input)', borderRadius: 8, overflow: 'auto', maxHeight: 400, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{`// Adam + Aruto Budget Widget for Scriptable
// With corgi mascot, week-vs-week, sparkline, and per-user comparison

const BASE_URL = "${window.location.origin}";
const TOKEN = "PASTE_YOUR_TOKEN_HERE";

async function fetchWidget() {
  const req = new Request(BASE_URL + "/api/widget");
  req.headers = { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" };
  return await req.loadJSON();
}

function fmt(n) { return "$" + Math.round(n).toLocaleString(); }

function timeAgo(dateStr, daysSince) {
  if (daysSince === null || daysSince === undefined) return "never";
  if (daysSince === 0) return "today";
  if (daysSince === 1) return "yesterday";
  return daysSince + "d ago";
}

function drawCorgi(ctx, x, y, s, happy) {
  // Body (rounded loaf shape)
  ctx.setFillColor(new Color("#E8A832"));
  ctx.fillEllipse(new Rect(x + 6*s, y + 12*s, 28*s, 16*s));
  // Fluffy butt
  ctx.fillEllipse(new Rect(x + 28*s, y + 11*s, 10*s, 14*s));
  // White belly
  ctx.setFillColor(new Color("#FFF5E0"));
  ctx.fillEllipse(new Rect(x + 10*s, y + 18*s, 20*s, 10*s));
  // Head
  ctx.setFillColor(new Color("#E8A832"));
  ctx.fillEllipse(new Rect(x + 0*s, y + 4*s, 18*s, 16*s));
  // White face blaze
  ctx.setFillColor(new Color("#FFF5E0"));
  ctx.fillEllipse(new Rect(x + 4*s, y + 10*s, 10*s, 10*s));
  // Left ear (triangle)
  ctx.setFillColor(new Color("#D4943A"));
  const le = new Path();
  le.move(new Point(x + 2*s, y + 8*s));
  le.addLine(new Point(x + 0*s, y + 0*s));
  le.addLine(new Point(x + 8*s, y + 6*s));
  le.closeSubpath();
  ctx.addPath(le); ctx.fillPath();
  // Left inner ear
  ctx.setFillColor(new Color("#FFD0B5"));
  const lie = new Path();
  lie.move(new Point(x + 3*s, y + 8*s));
  lie.addLine(new Point(x + 2*s, y + 3*s));
  lie.addLine(new Point(x + 7*s, y + 7*s));
  lie.closeSubpath();
  ctx.addPath(lie); ctx.fillPath();
  // Right ear
  ctx.setFillColor(new Color("#D4943A"));
  const re = new Path();
  re.move(new Point(x + 12*s, y + 8*s));
  re.addLine(new Point(x + 17*s, y + 0*s));
  re.addLine(new Point(x + 16*s, y + 6*s));
  re.closeSubpath();
  ctx.addPath(re); ctx.fillPath();
  // Right inner ear
  ctx.setFillColor(new Color("#FFD0B5"));
  const rie = new Path();
  rie.move(new Point(x + 13*s, y + 8*s));
  rie.addLine(new Point(x + 16*s, y + 3*s));
  rie.addLine(new Point(x + 15*s, y + 7*s));
  rie.closeSubpath();
  ctx.addPath(rie); ctx.fillPath();
  // Eyes
  ctx.setFillColor(new Color("#1a1a2e"));
  ctx.fillEllipse(new Rect(x + 5*s, y + 11*s, 2.5*s, 2.5*s));
  ctx.fillEllipse(new Rect(x + 11*s, y + 11*s, 2.5*s, 2.5*s));
  // Eye shine
  ctx.setFillColor(new Color("#FFFFFF"));
  ctx.fillEllipse(new Rect(x + 5.8*s, y + 11.3*s, 1*s, 1*s));
  ctx.fillEllipse(new Rect(x + 11.8*s, y + 11.3*s, 1*s, 1*s));
  // Eyebrows (sad only)
  if (!happy) {
    ctx.setStrokeColor(new Color("#1a1a2e"));
    ctx.setLineWidth(1.2*s);
    const lb = new Path();
    lb.move(new Point(x + 4*s, y + 10*s));
    lb.addLine(new Point(x + 7.5*s, y + 10.8*s));
    ctx.addPath(lb); ctx.strokePath();
    const rb = new Path();
    rb.move(new Point(x + 14*s, y + 10*s));
    rb.addLine(new Point(x + 10.5*s, y + 10.8*s));
    ctx.addPath(rb); ctx.strokePath();
  }
  // Nose
  ctx.setFillColor(new Color("#1a1a2e"));
  ctx.fillEllipse(new Rect(x + 7.5*s, y + 15*s, 3*s, 2*s));
  // Tongue (happy)
  if (happy) {
    ctx.setFillColor(new Color("#FF7B7B"));
    ctx.fillEllipse(new Rect(x + 8*s, y + 17*s, 2.5*s, 3.5*s));
  } else {
    // Frown
    ctx.setStrokeColor(new Color("#1a1a2e"));
    ctx.setLineWidth(0.8*s);
    const fr = new Path();
    fr.move(new Point(x + 7*s, y + 18.5*s));
    fr.addCurve(new Point(x + 11*s, y + 18.5*s), new Point(x + 8*s, y + 17*s), new Point(x + 10*s, y + 17*s));
    ctx.addPath(fr); ctx.strokePath();
  }
  // Front legs (stubby)
  ctx.setFillColor(new Color("#E8A832"));
  ctx.fillRect(new Rect(x + 8*s, y + 25*s, 4*s, 6*s));
  ctx.fillRect(new Rect(x + 16*s, y + 25*s, 4*s, 6*s));
  // Back legs
  ctx.fillRect(new Rect(x + 24*s, y + 25*s, 4*s, 6*s));
  // Paws
  ctx.setFillColor(new Color("#FFF5E0"));
  ctx.fillEllipse(new Rect(x + 7.5*s, y + 29*s, 5*s, 2.5*s));
  ctx.fillEllipse(new Rect(x + 15.5*s, y + 29*s, 5*s, 2.5*s));
  ctx.fillEllipse(new Rect(x + 23.5*s, y + 29*s, 5*s, 2.5*s));
  // Tail
  ctx.setFillColor(new Color("#D4943A"));
  const tail = new Path();
  if (happy) {
    tail.move(new Point(x + 35*s, y + 14*s));
    tail.addCurve(new Point(x + 40*s, y + 5*s), new Point(x + 36*s, y + 10*s), new Point(x + 42*s, y + 6*s));
    tail.addCurve(new Point(x + 35*s, y + 16*s), new Point(x + 39*s, y + 7*s), new Point(x + 36*s, y + 12*s));
  } else {
    tail.move(new Point(x + 35*s, y + 20*s));
    tail.addCurve(new Point(x + 38*s, y + 28*s), new Point(x + 36*s, y + 24*s), new Point(x + 40*s, y + 27*s));
    tail.addCurve(new Point(x + 35*s, y + 22*s), new Point(x + 37*s, y + 28*s), new Point(x + 36*s, y + 24*s));
  }
  tail.closeSubpath();
  ctx.addPath(tail); ctx.fillPath();
}

function drawSparkline(ctx, data, x, y, w, h, color) {
  if (!data || data.length < 2) return;
  const max = Math.max(...data.map(d => d.total), 1);
  const step = w / (data.length - 1);
  const area = new Path();
  area.move(new Point(x, y + h));
  for (let i = 0; i < data.length; i++) {
    area.addLine(new Point(x + i * step, y + h - (data[i].total / max) * h));
  }
  area.addLine(new Point(x + w, y + h));
  area.closeSubpath();
  ctx.setFillColor(new Color(color, 0.15));
  ctx.addPath(area); ctx.fillPath();
  ctx.setStrokeColor(new Color(color));
  ctx.setLineWidth(1.5);
  const line = new Path();
  for (let i = 0; i < data.length; i++) {
    const px = x + i * step;
    const py = y + h - (data[i].total / max) * h;
    if (i === 0) line.move(new Point(px, py));
    else line.addLine(new Point(px, py));
  }
  ctx.addPath(line); ctx.strokePath();
  const lastX = x + (data.length - 1) * step;
  const lastY = y + h - (data[data.length - 1].total / max) * h;
  ctx.setFillColor(new Color(color));
  ctx.fillEllipse(new Rect(lastX - 2.5, lastY - 2.5, 5, 5));
}

try {
  const d = await fetchWidget();
  const W = 338, H = 155;
  const ctx = new DrawContext();
  ctx.size = new Size(W, H);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  // Background
  ctx.setFillColor(new Color("#0f1117"));
  ctx.fillRect(new Rect(0, 0, W, H));

  // ── TOP ROW: Title + Corgi + Pace ──
  // Corgi (small, next to title)
  drawCorgi(ctx, 10, 2, 1.1, d.under_budget);

  // Title
  ctx.setFont(Font.boldSystemFont(13));
  ctx.setTextColor(new Color("#e8eaf0"));
  ctx.drawTextInRect("Adam + Aruto", new Rect(56, 6, 140, 18));
  ctx.setFont(Font.systemFont(10));
  ctx.setTextColor(new Color("#8b8fa3"));
  ctx.drawTextInRect("Budget", new Rect(56, 22, 60, 14));

  // Pace badge (top-right)
  const paceColor = d.under_budget ? "#00cec9" : "#ff6b6b";
  ctx.setFillColor(new Color(paceColor, 0.2));
  const pctW = 60;
  ctx.fillRect(new Rect(W - pctW - 12, 6, pctW, 20));
  ctx.setFont(Font.boldSystemFont(12));
  ctx.setTextColor(new Color(paceColor));
  ctx.drawTextInRect(d.pace_percent + "%", new Rect(W - pctW - 8, 9, pctW - 4, 16));

  // ── USER COMPARISON ROW (prominent) ──
  const userY = 40;
  const userW = (W - 36) / 2;
  for (let i = 0; i < Math.min(d.users.length, 2); i++) {
    const u = d.users[i];
    const ux = 12 + i * (userW + 12);
    const nameColor = u.name.toLowerCase().includes("adam") ? "#6c5ce7" : "#00cec9";
    const ago = timeAgo(u.last_added_at, u.days_since_last);
    const agoColor = u.days_since_last !== null && u.days_since_last <= 1 ? "#00cec9" : "#ff6b6b";

    // User card background
    ctx.setFillColor(new Color("#1a1d27"));
    ctx.fillRect(new Rect(ux, userY, userW, 36));

    // Color accent bar
    ctx.setFillColor(new Color(nameColor));
    ctx.fillRect(new Rect(ux, userY, 3, 36));

    // Name
    ctx.setFont(Font.boldSystemFont(11));
    ctx.setTextColor(new Color("#e8eaf0"));
    ctx.drawTextInRect(u.name.split(" ")[0], new Rect(ux + 8, userY + 3, 60, 15));

    // Amount
    ctx.setFont(Font.boldSystemFont(13));
    ctx.setTextColor(new Color(nameColor));
    ctx.drawTextInRect(fmt(u.month_total), new Rect(ux + 8, userY + 18, userW - 16, 16));

    // Last added (right side of card)
    ctx.setFont(Font.systemFont(8));
    ctx.setTextColor(new Color(agoColor));
    ctx.drawTextInRect(ago, new Rect(ux + userW - 52, userY + 5, 48, 12));

    // Txn count
    ctx.setFont(Font.systemFont(8));
    ctx.setTextColor(new Color("#8b8fa3"));
    ctx.drawTextInRect(u.month_count + " txns", new Rect(ux + userW - 52, userY + 18, 48, 12));
  }

  // ── MIDDLE: Week comparison + Sparkline ──
  const midY = 82;

  // This week
  ctx.setFont(Font.systemFont(8));
  ctx.setTextColor(new Color("#8b8fa3"));
  ctx.drawTextInRect("This wk", new Rect(12, midY, 40, 12));
  ctx.setFont(Font.boldSystemFont(13));
  ctx.setTextColor(new Color("#e8eaf0"));
  ctx.drawTextInRect(fmt(d.this_week_spent), new Rect(52, midY - 1, 70, 16));

  // Last week
  ctx.setFont(Font.systemFont(8));
  ctx.setTextColor(new Color("#8b8fa3"));
  ctx.drawTextInRect("Last wk", new Rect(12, midY + 16, 40, 12));
  ctx.setFont(Font.systemFont(11));
  ctx.setTextColor(new Color("#8b8fa3"));
  ctx.drawTextInRect(fmt(d.last_week_spent), new Rect(52, midY + 15, 70, 14));

  // Week change arrow
  const weekColor = d.week_change <= 0 ? "#00cec9" : "#ff6b6b";
  const weekSign = d.week_change >= 0 ? "+" : "";
  const weekArrow = d.week_change <= 0 ? "\\u2193" : "\\u2191";
  ctx.setFont(Font.boldSystemFont(10));
  ctx.setTextColor(new Color(weekColor));
  ctx.drawTextInRect(weekArrow + weekSign + d.week_change + "%", new Rect(122, midY + 5, 50, 14));

  // Sparkline (right side)
  const sparkColor = d.under_budget ? "#00cec9" : "#ff6b6b";
  drawSparkline(ctx, d.daily_breakdown, 178, midY, W - 190, 28, sparkColor);

  // ── BOTTOM: Progress bar + stats ──
  const bottomY = 115;
  ctx.setFillColor(new Color("#1a1d27"));
  ctx.fillRect(new Rect(0, bottomY - 2, W, H - bottomY + 2));

  // Progress bar
  const barW = W - 24;
  ctx.setFillColor(new Color("#2d3148"));
  ctx.fillRect(new Rect(12, bottomY + 1, barW, 4));
  const fillPct = Math.min(d.pace_percent, 100) / 100;
  const barColor = d.pace_percent <= 90 ? "#00cec9" : d.pace_percent <= 100 ? "#feca57" : "#ff6b6b";
  ctx.setFillColor(new Color(barColor));
  ctx.fillRect(new Rect(12, bottomY + 1, barW * fillPct, 4));

  // Stats row
  const statY = bottomY + 10;
  const stats = [
    { label: "Today", value: fmt(d.today_spent), color: "#e8eaf0" },
    { label: "Month", value: fmt(d.month_spent), color: "#6c5ce7" },
    { label: "Budget", value: fmt(d.monthly_budget), color: "#00cec9" },
    { label: "Projected", value: fmt(d.projected_monthly), color: d.under_budget ? "#00cec9" : "#ff6b6b" },
  ];
  const colW = (W - 24) / stats.length;
  for (let i = 0; i < stats.length; i++) {
    const cx = 12 + i * colW;
    ctx.setFont(Font.systemFont(7));
    ctx.setTextColor(new Color("#8b8fa3"));
    ctx.drawTextInRect(stats[i].label, new Rect(cx, statY, colW, 10));
    ctx.setFont(Font.boldSystemFont(10));
    ctx.setTextColor(new Color(stats[i].color));
    ctx.drawTextInRect(stats[i].value, new Rect(cx, statY + 10, colW, 14));
  }

  const w = new ListWidget();
  w.backgroundColor = new Color("#0f1117");
  w.backgroundImage = ctx.getImage();
  w.setPadding(0, 0, 0, 0);

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

      {tab === 'shortcuts' && (
        <div className="card">
          <div className="card-title"><Smartphone size={14} /> iOS Shortcuts — Quick Add Expenses</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Quickly record expenses from your iPhone using Siri or the Shortcuts app.
            The app auto-categorises using your learned category rules.
          </p>

          <div style={{ marginBottom: '1rem' }}>
            <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Your API Details</h4>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
              <code style={{ fontSize: '0.7rem', padding: '0.5rem', background: 'var(--bg-input)', borderRadius: 6, wordBreak: 'break-all' }}>
                POST {window.location.origin}/api/quick-add
              </code>
              <button className="btn btn-ghost btn-sm" onClick={() => {
                navigator.clipboard.writeText(window.location.origin + '/api/quick-add');
                alert('URL copied');
              }}>
                <Copy size={14} /> Copy URL
              </button>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <code style={{ fontSize: '0.7rem', padding: '0.5rem', background: 'var(--bg-input)', borderRadius: 6, wordBreak: 'break-all', flex: 1 }}>
                {localStorage.getItem('token')?.substring(0, 40)}...
              </code>
              <button className="btn btn-ghost btn-sm" onClick={() => {
                navigator.clipboard.writeText(localStorage.getItem('token') || '');
                alert('Token copied');
              }}>
                <Copy size={14} /> Copy Token
              </button>
            </div>
          </div>

          {/* ===== OPTION 1: Siri Shortcut ===== */}
          <div style={{ marginBottom: '1.5rem' }}>
            <h4 style={{ fontSize: '0.95rem', marginBottom: '0.5rem', color: 'var(--text)' }}>Option 1: "Hey Siri, add expense"</h4>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.5rem', lineHeight: 1.6 }}>
              Create a Shortcut you can trigger with Siri. It asks for amount and description,
              then records the expense. Best for on-the-go after tapping your card.
            </p>
            <div style={{ background: 'var(--bg-input)', borderRadius: 8, padding: '1rem', fontSize: '0.8rem', lineHeight: 1.9 }}>
              <p style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Setup:</p>
              <ol style={{ paddingLeft: '1.25rem', color: 'var(--text-muted)', margin: 0 }}>
                <li>Open <strong>Shortcuts</strong> → tap <strong>+</strong></li>
                <li>Name it <strong>"Add Expense"</strong></li>
                <li>Add action: <strong>Ask for Input</strong> → Type: Number → Prompt: "Amount?"</li>
                <li>Add action: <strong>Ask for Input</strong> → Type: Text → Prompt: "What for?"</li>
                <li>Add action: <strong>Get Contents of URL</strong></li>
              </ol>
              <p style={{ fontWeight: 600, marginTop: '0.75rem', marginBottom: '0.25rem' }}>URL action settings:</p>
              <p style={{ color: 'var(--text-muted)', margin: 0 }}>
                URL: <code style={{ background: 'var(--bg-card)', padding: '2px 6px', borderRadius: 4 }}>{window.location.origin}/api/quick-add</code><br/>
                Method: <strong>POST</strong><br/>
                Header: <code>Authorization</code> = <code>Bearer YOUR_TOKEN</code><br/>
                Header: <code>Content-Type</code> = <code>application/json</code><br/>
                Body (JSON): <code>{`{"amount": [Input 1], "description": [Input 2]}`}</code>
              </p>
              <p style={{ fontWeight: 600, marginTop: '0.75rem', marginBottom: '0.25rem' }}>Optional:</p>
              <p style={{ color: 'var(--text-muted)', margin: 0 }}>
                Add <strong>Show Notification</strong> with the result to confirm the category it was auto-assigned to.
              </p>
            </div>
          </div>

          {/* ===== OPTION 2: Apple Pay Automation ===== */}
          <div style={{ marginBottom: '1.5rem' }}>
            <h4 style={{ fontSize: '0.95rem', marginBottom: '0.5rem', color: 'var(--text)' }}>Option 2: Apple Pay Automation</h4>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.5rem', lineHeight: 1.6 }}>
              If you pay with Apple Pay, iOS can trigger a shortcut when you tap your card.
              Note: this only works for Apple Wallet transactions, not regular bank card taps.
            </p>
            <div style={{ background: 'var(--bg-input)', borderRadius: 8, padding: '1rem', fontSize: '0.8rem', lineHeight: 1.9 }}>
              <ol style={{ paddingLeft: '1.25rem', color: 'var(--text-muted)', margin: 0 }}>
                <li>Open <strong>Shortcuts</strong> → <strong>Automation</strong> tab</li>
                <li>Tap <strong>+</strong> → <strong>Transaction</strong></li>
                <li>Select your Apple Pay card</li>
                <li>Set to <strong>Run Immediately</strong></li>
                <li>Add action: <strong>Ask for Input</strong> → Number → "How much was that?"</li>
                <li>Add action: <strong>Get Contents of URL</strong> (same setup as Option 1)</li>
              </ol>
              <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', fontSize: '0.75rem' }}>
                Note: On iOS 18 this trigger can be flaky. If it doesn't fire, try disabling "Summarize Notifications" in Settings → Notifications → Wallet.
              </p>
            </div>
          </div>

          {/* ===== OPTION 3: Quick Test ===== */}
          <div style={{ marginBottom: '0.5rem' }}>
            <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Quick Test (cURL)</h4>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              Test the Quick Add API from your terminal:
            </p>
            <pre style={{ fontSize: '0.65rem', padding: '0.75rem', background: 'var(--bg-input)', borderRadius: 8, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{`curl -X POST ${window.location.origin}/api/quick-add \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"amount": 42.50, "description": "Woolworths Town Hall"}'`}</pre>
            <button className="btn btn-ghost btn-sm" style={{ marginTop: '0.5rem' }} onClick={() => {
              const token = localStorage.getItem('token') || 'YOUR_TOKEN';
              const cmd = `curl -X POST ${window.location.origin}/api/quick-add -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '{"amount": 42.50, "description": "Woolworths Town Hall"}'`;
              navigator.clipboard.writeText(cmd);
              alert('cURL command copied with your token');
            }}>
              <Copy size={14} /> Copy with Token
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
