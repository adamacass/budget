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
    pay_cycle: user?.pay_cycle || 'fortnightly',
    mortgage_contribution: user?.mortgage_contribution || ''
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
        pay_cycle: profile.pay_cycle,
        mortgage_contribution: parseFloat(profile.mortgage_contribution) || 0
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
            <div className="form-row">
              <div className="form-group">
                <label>Mortgage Contribution ($/month)</label>
                <input className="form-input" type="number" step="1" value={profile.mortgage_contribution} onChange={e => setProfile({ ...profile, mortgage_contribution: e.target.value })} placeholder="e.g. 2857" />
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>Your share of the monthly mortgage payment (auto-debited from offset on 25th)</div>
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
          <div className="card-title">Account Balances</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Update your offset balance to match your actual bank statement. This is the primary account — all surplus flows here.
          </p>
          {['offset', 'savings', 'credit_card', 'investment'].map(acct => (
            <div key={acct} style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem', opacity: acct === 'offset' ? 1 : 0.6 }}>
              <div style={{ width: 150, fontWeight: acct === 'offset' ? 700 : 500, fontSize: '0.9rem', textTransform: 'capitalize' }}>
                {acct === 'offset' ? 'Offset (Primary)' : acct.replace('_', ' ')}
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
          <pre id="scriptable-code" style={{ fontSize: '0.65rem', lineHeight: 1.5, padding: '1rem', background: 'var(--bg-input)', borderRadius: 8, overflow: 'auto', maxHeight: 400, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{`// Budget Widget — Scriptable
// Minimal, clean design with dark/light support

const BASE_URL = "${window.location.origin}";
const TOKEN = "PASTE_YOUR_TOKEN_HERE";

async function fetchWidget() {
  const req = new Request(BASE_URL + "/api/widget");
  req.headers = { "Authorization": "Bearer " + TOKEN };
  return await req.loadJSON();
}

function fmt(n) { return "$" + Math.round(n).toLocaleString(); }

function timeAgo(ds) {
  if (ds === null || ds === undefined) return "";
  if (ds === 0) return "today";
  if (ds === 1) return "1d ago";
  return ds + "d ago";
}

function roundedRect(ctx, x, y, w, h, r, color) {
  const p = new Path();
  p.move(new Point(x + r, y));
  p.addLine(new Point(x + w - r, y));
  p.addCurve(new Point(x + w, y + r), new Point(x + w, y), new Point(x + w, y));
  p.addLine(new Point(x + w, y + h - r));
  p.addCurve(new Point(x + w - r, y + h), new Point(x + w, y + h), new Point(x + w, y + h));
  p.addLine(new Point(x + r, y + h));
  p.addCurve(new Point(x, y + h - r), new Point(x, y + h), new Point(x, y + h));
  p.addLine(new Point(x, y + r));
  p.addCurve(new Point(x + r, y), new Point(x, y), new Point(x, y));
  p.closeSubpath();
  ctx.setFillColor(color);
  ctx.addPath(p); ctx.fillPath();
}

function drawSparkline(ctx, data, x, y, w, h, color) {
  if (!data || data.length < 2) return;
  const max = Math.max(...data.map(d => d.total), 1);
  const step = w / (data.length - 1);
  // Gradient fill
  const area = new Path();
  area.move(new Point(x, y + h));
  for (let i = 0; i < data.length; i++)
    area.addLine(new Point(x + i * step, y + h - (data[i].total / max) * h));
  area.addLine(new Point(x + w, y + h));
  area.closeSubpath();
  ctx.setFillColor(new Color(color, 0.08));
  ctx.addPath(area); ctx.fillPath();
  // Line
  ctx.setStrokeColor(new Color(color, 0.6));
  ctx.setLineWidth(1.5);
  const line = new Path();
  for (let i = 0; i < data.length; i++) {
    const px = x + i * step, py = y + h - (data[i].total / max) * h;
    if (i === 0) line.move(new Point(px, py));
    else line.addLine(new Point(px, py));
  }
  ctx.addPath(line); ctx.strokePath();
  // End dot
  const lx = x + (data.length - 1) * step;
  const ly = y + h - (data[data.length - 1].total / max) * h;
  ctx.setFillColor(new Color(color));
  ctx.fillEllipse(new Rect(lx - 2.5, ly - 2.5, 5, 5));
}

try {
  const d = await fetchWidget();
  if (!d || d.error) throw new Error(d?.error || "No data");
  const dark = Device.isUsingDarkAppearance();

  const bg     = dark ? "#0d0f14" : "#fafafa";
  const card   = dark ? "#171a23" : "#ffffff";
  const text1  = dark ? "#e8eaf0" : "#111318";
  const text2  = dark ? "#5c6178" : "#9096a8";
  const accent1 = "#7c6cf0";
  const accent2 = "#00cec9";
  const green  = "#10b981";
  const red    = "#ef4444";

  const W = 338, H = 155;
  const ctx = new DrawContext();
  ctx.size = new Size(W, H);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  // BG
  ctx.setFillColor(new Color(bg));
  ctx.fillRect(new Rect(0, 0, W, H));

  // ── TOP ROW: Big spend number + pace pill ──
  const paceOk = d.under_budget;
  const paceCol = paceOk ? green : red;

  ctx.setFont(Font.systemFont(9));
  ctx.setTextColor(new Color(text2));
  ctx.drawTextInRect("THIS WEEK", new Rect(16, 10, 80, 12));

  ctx.setFont(Font.boldRoundedSystemFont(28));
  ctx.setTextColor(new Color(text1));
  ctx.drawTextInRect(fmt(d.this_week_spent), new Rect(16, 22, 180, 34));

  // Week change tag
  const wkCol = d.week_change <= 0 ? green : red;
  const wkLabel = (d.week_change <= 0 ? "\\u2193" : "\\u2191") + " " + Math.abs(d.week_change) + "% vs last wk";
  ctx.setFont(Font.mediumSystemFont(9));
  ctx.setTextColor(new Color(wkCol));
  ctx.drawTextInRect(wkLabel, new Rect(16, 56, 140, 12));

  // Pace pill (top-right)
  roundedRect(ctx, W - 72, 12, 58, 24, 12, new Color(paceCol, dark ? 0.18 : 0.1));
  ctx.setFont(Font.boldRoundedSystemFont(13));
  ctx.setTextColor(new Color(paceCol));
  ctx.drawTextInRect(d.pace_percent + "%", new Rect(W - 66, 16, 46, 16));
  ctx.setFont(Font.systemFont(7));
  ctx.setTextColor(new Color(text2));
  ctx.drawTextInRect("of budget", new Rect(W - 72, 37, 58, 10));

  // Sparkline (top-right area, behind pace)
  drawSparkline(ctx, d.daily_breakdown, W - 150, 50, 136, 22, paceCol);

  // ── DIVIDER ──
  roundedRect(ctx, 16, 76, W - 32, 0.5, 0.25, new Color(text2, 0.15));

  // ── BOTTOM: Two user columns + stats ──
  const users = d.users || [];
  const colW = (W - 44) / 3;
  const botY = 84;

  for (let i = 0; i < Math.min(users.length, 2); i++) {
    const u = users[i];
    const cx = 16 + i * (colW + 6);
    const isAdam = u.name.toLowerCase().includes("adam");
    const accent = isAdam ? accent1 : accent2;
    const ago = timeAgo(u.days_since_last);

    // Accent dot
    ctx.setFillColor(new Color(accent));
    ctx.fillEllipse(new Rect(cx, botY + 3, 5, 5));

    // Name
    ctx.setFont(Font.boldSystemFont(10));
    ctx.setTextColor(new Color(text1));
    ctx.drawTextInRect(u.name.split(" ")[0], new Rect(cx + 9, botY, 60, 13));

    // Week total
    ctx.setFont(Font.boldRoundedSystemFont(18));
    ctx.setTextColor(new Color(accent));
    ctx.drawTextInRect(fmt(u.week_total), new Rect(cx, botY + 16, colW, 22));

    // Subtitle
    ctx.setFont(Font.systemFont(8));
    ctx.setTextColor(new Color(text2));
    const sub = u.week_count + " txns" + (ago ? " · " + ago : "");
    ctx.drawTextInRect(sub, new Rect(cx, botY + 38, colW, 11));

    // Monthly total small
    ctx.setFont(Font.systemFont(7));
    ctx.setTextColor(new Color(text2));
    ctx.drawTextInRect(fmt(u.month_total) + "/mo", new Rect(cx, botY + 50, colW, 10));
  }

  // ── RIGHT COLUMN: Key stats ──
  const sx = 16 + 2 * (colW + 6);
  const statsData = [
    { lbl: "Today", val: fmt(d.today_spent) },
    { lbl: "Monthly", val: fmt(d.month_spent) + " / " + fmt(d.monthly_budget) },
    { lbl: "Projected", val: fmt(d.projected_monthly) },
    { lbl: "Daily avg", val: fmt(d.daily_average) },
  ];
  for (let i = 0; i < statsData.length; i++) {
    const sy = botY + i * 16;
    ctx.setFont(Font.systemFont(7));
    ctx.setTextColor(new Color(text2));
    ctx.drawTextInRect(statsData[i].lbl, new Rect(sx, sy, colW + 10, 9));
    ctx.setFont(Font.boldSystemFont(9));
    ctx.setTextColor(new Color(i === 2 ? paceCol : text1));
    ctx.drawTextInRect(statsData[i].val, new Rect(sx, sy + 8, colW + 10, 11));
  }

  const w = new ListWidget();
  w.backgroundColor = new Color(bg);
  w.backgroundImage = ctx.getImage();
  w.setPadding(0, 0, 0, 0);
  if (config.runsInWidget) Script.setWidget(w);
  else await w.presentMedium();
} catch (e) {
  const w = new ListWidget();
  const dark = Device.isUsingDarkAppearance();
  w.backgroundColor = new Color(dark ? "#0d0f14" : "#fafafa");
  const t = w.addText("Budget");
  t.font = Font.boldRoundedSystemFont(14);
  t.textColor = new Color(dark ? "#e8eaf0" : "#111318");
  w.addSpacer(4);
  const err = w.addText(e.message);
  err.font = Font.systemFont(11);
  err.textColor = new Color("#ef4444");
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
