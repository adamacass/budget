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
          <pre id="scriptable-code" style={{ fontSize: '0.65rem', lineHeight: 1.5, padding: '1rem', background: 'var(--bg-input)', borderRadius: 8, overflow: 'auto', maxHeight: 400, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{`// Budget Corgi Widget for Scriptable
// Beautiful widget with drawn corgi, week-vs-week comparison, and sparkline

const BASE_URL = "${window.location.origin}";
const TOKEN = "PASTE_YOUR_TOKEN_HERE";

async function fetchWidget() {
  const req = new Request(BASE_URL + "/api/widget");
  req.headers = { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" };
  return await req.loadJSON();
}

function fmt(n) { return "$" + Math.round(n).toLocaleString(); }

function drawCorgi(ctx, x, y, size, happy) {
  // Golden corgi body
  const s = size / 50;
  // Body
  ctx.setFillColor(new Color("#D4943A"));
  ctx.fillEllipse(new Rect(x + 8*s, y + 18*s, 34*s, 22*s));
  // Head
  ctx.fillEllipse(new Rect(x + 2*s, y + 8*s, 22*s, 20*s));
  // White face marking
  ctx.setFillColor(new Color("#FFF5E0"));
  ctx.fillEllipse(new Rect(x + 6*s, y + 14*s, 14*s, 14*s));
  // Left ear
  ctx.setFillColor(new Color("#C4842A"));
  const earPts = [
    new Point(x + 4*s, y + 12*s),
    new Point(x + 1*s, y + 0*s),
    new Point(x + 12*s, y + 10*s),
  ];
  const ear = new Path();
  ear.move(earPts[0]);
  ear.addLine(earPts[1]);
  ear.addLine(earPts[2]);
  ear.closeSubpath();
  ctx.addPath(ear);
  ctx.fillPath();
  // Right ear
  const rEar = new Path();
  rEar.move(new Point(x + 14*s, y + 12*s));
  rEar.addLine(new Point(x + 22*s, y + 0*s));
  rEar.addLine(new Point(x + 20*s, y + 10*s));
  rEar.closeSubpath();
  ctx.addPath(rEar);
  ctx.fillPath();
  // Inner ears
  ctx.setFillColor(new Color("#FFBFA0"));
  const iEar = new Path();
  iEar.move(new Point(x + 5*s, y + 12*s));
  iEar.addLine(new Point(x + 3*s, y + 4*s));
  iEar.addLine(new Point(x + 10*s, y + 11*s));
  iEar.closeSubpath();
  ctx.addPath(iEar);
  ctx.fillPath();
  const iREar = new Path();
  iREar.move(new Point(x + 15*s, y + 12*s));
  iREar.addLine(new Point(x + 20*s, y + 4*s));
  iREar.addLine(new Point(x + 19*s, y + 11*s));
  iREar.closeSubpath();
  ctx.addPath(iREar);
  ctx.fillPath();
  // Eyes
  ctx.setFillColor(new Color("#2d2d2d"));
  ctx.fillEllipse(new Rect(x + 8*s, y + 17*s, 3*s, 3*s));
  ctx.fillEllipse(new Rect(x + 15*s, y + 17*s, 3*s, 3*s));
  // Eye shine
  ctx.setFillColor(new Color("#FFFFFF"));
  ctx.fillEllipse(new Rect(x + 9*s, y + 17.5*s, 1.2*s, 1.2*s));
  ctx.fillEllipse(new Rect(x + 16*s, y + 17.5*s, 1.2*s, 1.2*s));
  // Nose
  ctx.setFillColor(new Color("#2d2d2d"));
  ctx.fillEllipse(new Rect(x + 11*s, y + 22*s, 4*s, 3*s));
  // Mouth / tongue
  if (happy) {
    ctx.setFillColor(new Color("#FF7979"));
    ctx.fillEllipse(new Rect(x + 11.5*s, y + 25*s, 3*s, 4*s));
  } else {
    // Sad eyebrows
    ctx.setStrokeColor(new Color("#2d2d2d"));
    ctx.setLineWidth(1.5*s);
    const lBrow = new Path();
    lBrow.move(new Point(x + 7*s, y + 15*s));
    lBrow.addLine(new Point(x + 11*s, y + 16*s));
    ctx.addPath(lBrow); ctx.strokePath();
    const rBrow = new Path();
    rBrow.move(new Point(x + 19*s, y + 15*s));
    rBrow.addLine(new Point(x + 15*s, y + 16*s));
    ctx.addPath(rBrow); ctx.strokePath();
  }
  // Legs
  ctx.setFillColor(new Color("#D4943A"));
  ctx.fillRect(new Rect(x + 12*s, y + 35*s, 5*s, 8*s));
  ctx.fillRect(new Rect(x + 22*s, y + 35*s, 5*s, 8*s));
  ctx.fillRect(new Rect(x + 30*s, y + 35*s, 5*s, 8*s));
  // Fluffy butt
  ctx.fillEllipse(new Rect(x + 34*s, y + 18*s, 12*s, 16*s));
  // Tail (wagging up for happy, down for sad)
  ctx.setFillColor(new Color("#C4842A"));
  const tail = new Path();
  if (happy) {
    tail.move(new Point(x + 42*s, y + 20*s));
    tail.addCurve(new Point(x + 48*s, y + 8*s), new Point(x + 44*s, y + 14*s), new Point(x + 50*s, y + 10*s));
    tail.addLine(new Point(x + 46*s, y + 10*s));
    tail.addCurve(new Point(x + 42*s, y + 22*s), new Point(x + 48*s, y + 12*s), new Point(x + 42*s, y + 16*s));
  } else {
    tail.move(new Point(x + 42*s, y + 28*s));
    tail.addCurve(new Point(x + 46*s, y + 38*s), new Point(x + 44*s, y + 32*s), new Point(x + 48*s, y + 36*s));
    tail.addLine(new Point(x + 44*s, y + 38*s));
    tail.addCurve(new Point(x + 42*s, y + 30*s), new Point(x + 46*s, y + 36*s), new Point(x + 42*s, y + 32*s));
  }
  tail.closeSubpath();
  ctx.addPath(tail);
  ctx.fillPath();
}

function drawSparkline(ctx, data, x, y, w, h, color) {
  if (!data || data.length < 2) return;
  const max = Math.max(...data.map(d => d.total), 1);
  const step = w / (data.length - 1);
  // Fill area
  const area = new Path();
  area.move(new Point(x, y + h));
  for (let i = 0; i < data.length; i++) {
    const px = x + i * step;
    const py = y + h - (data[i].total / max) * h;
    area.addLine(new Point(px, py));
  }
  area.addLine(new Point(x + w, y + h));
  area.closeSubpath();
  ctx.setFillColor(new Color(color, 0.15));
  ctx.addPath(area);
  ctx.fillPath();
  // Stroke line
  ctx.setStrokeColor(new Color(color));
  ctx.setLineWidth(1.5);
  const line = new Path();
  for (let i = 0; i < data.length; i++) {
    const px = x + i * step;
    const py = y + h - (data[i].total / max) * h;
    if (i === 0) line.move(new Point(px, py));
    else line.addLine(new Point(px, py));
  }
  ctx.addPath(line);
  ctx.strokePath();
  // Dot on latest point
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

  // Background gradient
  ctx.setFillColor(new Color("#0f1117"));
  ctx.fillRect(new Rect(0, 0, W, H));
  // Subtle gradient overlay
  ctx.setFillColor(new Color("#161927", 0.6));
  ctx.fillRect(new Rect(0, 0, W, H * 0.5));

  // Draw corgi in top-right
  drawCorgi(ctx, W - 68, 6, 58, d.under_budget);

  // Title
  ctx.setFont(Font.boldSystemFont(14));
  ctx.setTextColor(new Color("#e8eaf0"));
  ctx.drawTextInRect("Budget Corgi", new Rect(12, 8, 200, 20));

  // Pace badge
  const paceColor = d.under_budget ? "#00cec9" : "#ff6b6b";
  ctx.setFillColor(new Color(paceColor, 0.18));
  const paceText = d.pace_percent + "% pace";
  ctx.fillRect(new Rect(12, 28, 72, 18));
  ctx.setFont(Font.boldSystemFont(10));
  ctx.setTextColor(new Color(paceColor));
  ctx.drawTextInRect(paceText, new Rect(16, 30, 65, 16));

  // Week-vs-week comparison
  const weekChangeSign = d.week_change >= 0 ? "+" : "";
  const weekColor = d.week_change <= 0 ? "#00cec9" : "#ff6b6b";
  const weekArrow = d.week_change <= 0 ? "\\u2193" : "\\u2191";

  ctx.setFont(Font.systemFont(9));
  ctx.setTextColor(new Color("#8b8fa3"));
  ctx.drawTextInRect("This week", new Rect(12, 52, 60, 14));
  ctx.drawTextInRect("Last week", new Rect(12, 78, 60, 14));
  ctx.drawTextInRect("vs", new Rect(12, 98, 20, 14));

  ctx.setFont(Font.boldSystemFont(16));
  ctx.setTextColor(new Color("#e8eaf0"));
  ctx.drawTextInRect(fmt(d.this_week_spent), new Rect(70, 49, 100, 20));

  ctx.setFont(Font.systemFont(13));
  ctx.setTextColor(new Color("#8b8fa3"));
  ctx.drawTextInRect(fmt(d.last_week_spent), new Rect(70, 76, 100, 18));

  ctx.setFont(Font.boldSystemFont(12));
  ctx.setTextColor(new Color(weekColor));
  ctx.drawTextInRect(weekArrow + " " + weekChangeSign + d.week_change + "%", new Rect(32, 96, 80, 16));

  // Sparkline (last 7 days)
  const sparkColor = d.under_budget ? "#00cec9" : "#ff6b6b";
  drawSparkline(ctx, d.daily_breakdown, 140, 50, 120, 44, sparkColor);

  // Day labels under sparkline
  ctx.setFont(Font.systemFont(6));
  ctx.setTextColor(new Color("#8b8fa3"));
  if (d.daily_breakdown && d.daily_breakdown.length >= 7) {
    const step = 120 / 6;
    for (let i = 0; i < 7; i++) {
      ctx.drawTextInRect(d.daily_breakdown[i].date, new Rect(140 + i * step - 8, 96, 20, 10));
    }
  }

  // Bottom row: Monthly stats
  const bottomY = 115;
  ctx.setFillColor(new Color("#1a1d27"));
  ctx.fillRect(new Rect(0, bottomY - 4, W, H - bottomY + 4));

  // Progress bar
  const barY = bottomY + 2;
  const barW = W - 24;
  ctx.setFillColor(new Color("#2d3148"));
  ctx.fillRect(new Rect(12, barY, barW, 5));
  const fillPct = Math.min(d.pace_percent, 100) / 100;
  const barColor = d.pace_percent <= 90 ? "#00cec9" : d.pace_percent <= 100 ? "#feca57" : "#ff6b6b";
  ctx.setFillColor(new Color(barColor));
  ctx.fillRect(new Rect(12, barY, barW * fillPct, 5));

  // Monthly totals row
  const statY = barY + 12;
  const statCols = [
    { label: "Today", value: fmt(d.today_spent), color: "#e8eaf0" },
    { label: "Month", value: fmt(d.month_spent), color: "#6c5ce7" },
    { label: "Budget", value: fmt(d.monthly_budget), color: "#00cec9" },
    { label: "Projected", value: fmt(d.projected_monthly), color: d.under_budget ? "#00cec9" : "#ff6b6b" },
  ];
  const colW = (W - 24) / statCols.length;
  for (let i = 0; i < statCols.length; i++) {
    const cx = 12 + i * colW;
    ctx.setFont(Font.systemFont(7));
    ctx.setTextColor(new Color("#8b8fa3"));
    ctx.drawTextInRect(statCols[i].label, new Rect(cx, statY, colW, 10));
    ctx.setFont(Font.boldSystemFont(10));
    ctx.setTextColor(new Color(statCols[i].color));
    ctx.drawTextInRect(statCols[i].value, new Rect(cx, statY + 10, colW, 14));
  }

  // Per-user dots (top-right, below corgi)
  let userY = 54;
  ctx.setFont(Font.systemFont(8));
  for (const u of d.users) {
    const nameColor = u.name.toLowerCase().includes("adam") ? "#6c5ce7" : "#00cec9";
    ctx.setFillColor(new Color(nameColor));
    ctx.fillEllipse(new Rect(W - 66, userY + 2, 5, 5));
    ctx.setTextColor(new Color("#e8eaf0"));
    ctx.drawTextInRect(u.name.split(" ")[0], new Rect(W - 58, userY, 30, 12));
    ctx.setTextColor(new Color("#8b8fa3"));
    ctx.drawTextInRect(fmt(u.month_total), new Rect(W - 30, userY, 28, 12));
    userY += 14;
  }

  // Build widget
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
          <div className="card-title"><Smartphone size={14} /> iOS Shortcuts — Auto-Record from Notifications</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Automatically record expenses when your bank sends a push notification. Uses the iOS Shortcuts app
            with a <strong>Personal Automation</strong> triggered by notifications.
          </p>

          <div style={{ marginBottom: '1rem' }}>
            <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>How it Works</h4>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.7 }}>
              When your bank app sends a notification like <em>"You spent $42.50 at Woolworths"</em>,
              the Shortcut extracts the amount and description, then calls your budget app's Quick Add API.
              The app auto-categorises the expense using your learned category rules.
            </p>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Setup Instructions</h4>
            <ol style={{ fontSize: '0.82rem', lineHeight: 2, paddingLeft: '1.25rem', color: 'var(--text-muted)' }}>
              <li>Open the <strong>Shortcuts</strong> app on your iPhone</li>
              <li>Tap <strong>Automation</strong> tab at the bottom</li>
              <li>Tap <strong>+</strong> → <strong>Create Personal Automation</strong></li>
              <li>Scroll down and choose <strong>Notification</strong></li>
              <li>Select your <strong>bank app</strong> (e.g. CommBank, Westpac, ANZ, NAB)</li>
              <li>Choose <strong>"Contains"</strong> and enter a keyword like <code>spent</code> or <code>purchase</code></li>
              <li>Tap <strong>Next</strong>, then add the actions below in order</li>
              <li>Turn <strong>OFF</strong> "Ask Before Running" so it runs automatically</li>
            </ol>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Your API Endpoint</h4>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
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
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Auth Token</h4>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <code style={{ fontSize: '0.7rem', padding: '0.5rem', background: 'var(--bg-input)', borderRadius: 6, wordBreak: 'break-all', flex: 1 }}>
                {localStorage.getItem('token')?.substring(0, 40)}...
              </code>
              <button className="btn btn-ghost btn-sm" onClick={() => {
                navigator.clipboard.writeText(localStorage.getItem('token') || '');
                alert('Token copied');
              }}>
                <Copy size={14} /> Copy
              </button>
            </div>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Shortcut Actions (step by step)</h4>
            <div style={{ background: 'var(--bg-input)', borderRadius: 8, padding: '1rem', fontSize: '0.8rem', lineHeight: 1.9 }}>
              <p style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Action 1: Get text from Shortcut Input</p>
              <p style={{ color: 'var(--text-muted)' }}>This gives you the notification body text.</p>

              <p style={{ fontWeight: 600, marginBottom: '0.5rem', marginTop: '0.75rem' }}>Action 2: Match Text</p>
              <p style={{ color: 'var(--text-muted)' }}>Pattern: <code style={{ background: 'var(--bg-card)', padding: '2px 6px', borderRadius: 4 }}>\$[\d,.]+</code></p>
              <p style={{ color: 'var(--text-muted)' }}>Input: <em>Text from Step 1</em></p>

              <p style={{ fontWeight: 600, marginBottom: '0.5rem', marginTop: '0.75rem' }}>Action 3: Get Item from List</p>
              <p style={{ color: 'var(--text-muted)' }}>Get <strong>First Item</strong> from <em>Matches from Step 2</em></p>

              <p style={{ fontWeight: 600, marginBottom: '0.5rem', marginTop: '0.75rem' }}>Action 4: Replace Text</p>
              <p style={{ color: 'var(--text-muted)' }}>Find <code>$</code> and <code>,</code> — replace with nothing. This gives you the raw number.</p>

              <p style={{ fontWeight: 600, marginBottom: '0.5rem', marginTop: '0.75rem' }}>Action 5: Get Contents of URL</p>
              <p style={{ color: 'var(--text-muted)' }}>
                URL: <code style={{ background: 'var(--bg-card)', padding: '2px 6px', borderRadius: 4 }}>{window.location.origin}/api/quick-add</code><br/>
                Method: <strong>POST</strong><br/>
                Headers: <code>Authorization</code> = <code>Bearer YOUR_TOKEN</code><br/>
                Headers: <code>Content-Type</code> = <code>application/json</code><br/>
                Body (JSON):<br/>
                <code style={{ background: 'var(--bg-card)', padding: '4px 8px', borderRadius: 4, display: 'inline-block', marginTop: 4 }}>
                  {`{"amount": [Result from Step 4], "description": [Text from Step 1]}`}
                </code>
              </p>

              <p style={{ fontWeight: 600, marginBottom: '0.5rem', marginTop: '0.75rem' }}>Action 6 (Optional): Show Notification</p>
              <p style={{ color: 'var(--text-muted)' }}>
                Title: "Budget recorded"<br/>
                Body: <em>Result from Step 5</em> — this will show the category it was auto-assigned to.
              </p>
            </div>
          </div>

          <div style={{ marginBottom: '0.5rem' }}>
            <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Quick Test (cURL)</h4>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              Test the API from your terminal to make sure it works:
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
