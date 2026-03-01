import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getBalances, updateBalance, exportToExcel, downloadBackup, restoreBackup } from '../api';
import { Save, Download, Key, User, DollarSign, Database, Upload } from 'lucide-react';

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

  useEffect(() => {
    getBalances().then(setBalances).catch(console.error);
  }, []);

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
    </div>
  );
}
