import React, { useState, useEffect, useRef } from 'react';
import {
  getBotStatus, createLinkCode, getBotLinks, updateBotLink, deleteBotLink,
  getBotActivity, sendDigestNow, updateDigestSettings, getSystemInfo, getUsers,
} from '../api';
import {
  Bot, Smartphone, Link2, Send, Activity, Server, Copy, Check,
  RefreshCw, Trash2, AlertTriangle, CheckCircle, Clock, ArrowDownLeft,
  ArrowUpRight, Terminal, CalendarClock,
} from 'lucide-react';

const STATUS_POLL_MS = 15000;

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })
    + ' ' + d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(d) {
  if (!d) return '—';
  const s = String(d).split('T')[0];
  const parts = s.split('-');
  if (parts.length !== 3) return s;
  return `${parseInt(parts[2])}/${parseInt(parts[1])}/${parts[0]}`;
}

function fmtRelative(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return String(iso);
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 0) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDateTime(iso);
}

function fmtUptime(seconds) {
  const s = Number(seconds);
  if (!s || s < 0 || isNaN(s)) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(s)}s`;
}

function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  if (isNaN(v)) return String(n);
  return v.toLocaleString('en-AU');
}

// "30 4 * * *" -> "04:30" when it's a plain daily time, otherwise null
function cronToTime(expr) {
  const m = /^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*\s*$/.exec(String(expr || ''));
  if (!m) return null;
  const min = parseInt(m[1]), hour = parseInt(m[2]);
  if (isNaN(min) || isNaN(hour) || min > 59 || hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function timeToCron(time) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(time || ''));
  if (!m) return null;
  const hour = parseInt(m[1]), min = parseInt(m[2]);
  if (isNaN(min) || isNaN(hour) || min > 59 || hour > 23) return null;
  return `${min} ${hour} * * *`;
}

const COUNT_LABELS = {
  users: 'Users',
  expenses: 'Expenses',
  income_entries: 'Income entries',
  account_balances: 'Balance snapshots',
  savings_goals: 'Savings goals',
  offset_withdrawals: 'Offset movements',
  planned_withdrawals: 'Planned withdrawals',
  telegram_links: 'Telegram links',
};

export default function Admin() {
  const [status, setStatus] = useState(null);
  const [links, setLinks] = useState([]);
  const [activity, setActivity] = useState([]);
  const [system, setSystem] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Link code
  const [linkUser, setLinkUser] = useState('');
  const [linkCode, setLinkCode] = useState(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // Digest
  const [digestTime, setDigestTime] = useState('08:00');
  const [rawCron, setRawCron] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [refreshingActivity, setRefreshingActivity] = useState(false);
  const flashTimer = useRef(null);

  function flash(text, isError) {
    if (isError) { setErr(text); setMsg(''); }
    else { setMsg(text); setErr(''); }
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => { setMsg(''); setErr(''); }, 5000);
  }

  function applyDigestFromStatus(s) {
    const cron = s?.digest_cron || '';
    setRawCron(cron);
    const t = cronToTime(cron);
    if (t) { setDigestTime(t); setShowAdvanced(false); }
    else if (cron) { setShowAdvanced(true); }
  }

  async function loadAll() {
    try {
      const [s, l, a, sys, u] = await Promise.all([
        getBotStatus(), getBotLinks(), getBotActivity(50), getSystemInfo(), getUsers(),
      ]);
      setStatus(s || null);
      setLinks(Array.isArray(l) ? l : []);
      setActivity(Array.isArray(a) ? a : []);
      setSystem(sys || null);
      const userList = Array.isArray(u) ? u : [];
      setUsers(userList);
      setLinkUser(prev => prev || (userList[0] ? String(userList[0].id) : ''));
      applyDigestFromStatus(s);
    } catch (e) {
      flash(e.message || 'Failed to load admin data', true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAll(); }, []);

  // Keep the bot status honest without a manual refresh
  useEffect(() => {
    const id = setInterval(() => {
      getBotStatus().then(s => { if (s) setStatus(s); }).catch(() => {});
    }, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // Countdown on the live link code
  useEffect(() => {
    if (!codeExpiresAt) return;
    function tick() {
      setSecondsLeft(Math.max(0, Math.round((codeExpiresAt - Date.now()) / 1000)));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [codeExpiresAt]);

  async function handleGenerateCode() {
    setBusy(true);
    setCopied(false); setCopyFailed(false);
    try {
      const r = await createLinkCode(linkUser ? parseInt(linkUser) : undefined);
      setLinkCode(r || null);
      const mins = Number(r?.expires_in_minutes) || 30;
      setCodeExpiresAt(Date.now() + mins * 60 * 1000);
      flash(`Code ready for ${r?.display_name || 'that user'} — send it to the bot within ${mins} minutes.`);
    } catch (e) {
      flash(e.message || 'Could not create a link code', true);
    }
    setBusy(false);
  }

  async function handleCopy(text) {
    setCopied(false); setCopyFailed(false);
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard access is blocked on plain-HTTP origins — say so and leave the code on screen
      setCopyFailed(true);
    }
  }

  async function handleToggleLink(link, field) {
    setBusy(true);
    try {
      await updateBotLink(link.id, { [field]: !link[field] });
      const fresh = await getBotLinks();
      setLinks(Array.isArray(fresh) ? fresh : []);
    } catch (e) {
      flash(e.message || 'Could not update that chat', true);
    }
    setBusy(false);
  }

  async function handleUnlink(link) {
    const who = link.display_name || link.first_name || link.telegram_username || 'this chat';
    if (!window.confirm(`Unlink ${who}? That phone will stop being able to log expenses until it links again.`)) return;
    setBusy(true);
    try {
      await deleteBotLink(link.id);
      const [fresh, s] = await Promise.all([getBotLinks(), getBotStatus().catch(() => null)]);
      setLinks(Array.isArray(fresh) ? fresh : []);
      if (s) setStatus(s);
      flash('Unlinked.');
    } catch (e) {
      flash(e.message || 'Could not unlink that chat', true);
    }
    setBusy(false);
  }

  async function handleSaveDigest(useRaw) {
    const expr = useRaw ? rawCron.trim() : timeToCron(digestTime);
    if (!expr) { flash('Pick a valid time first', true); return; }
    setBusy(true);
    try {
      const r = await updateDigestSettings({ digest_cron: expr });
      const saved = r?.digest_cron || expr;
      setRawCron(saved);
      const t = cronToTime(saved);
      if (t) setDigestTime(t);
      const s = await getBotStatus().catch(() => null);
      if (s) setStatus(s);
      flash(`Digest schedule saved (${saved}).`);
    } catch (e) {
      flash(e.message || 'Could not save that schedule', true);
    }
    setBusy(false);
  }

  async function handleToggleDigest() {
    setBusy(true);
    try {
      const next = !status?.digest_enabled;
      await updateDigestSettings({ digest_enabled: next });
      const s = await getBotStatus().catch(() => null);
      if (s) setStatus(s);
      flash(next ? 'Daily digest turned on.' : 'Daily digest turned off.');
    } catch (e) {
      flash(e.message || 'Could not change that', true);
    }
    setBusy(false);
  }

  async function handleSendNow() {
    setBusy(true);
    try {
      const r = await sendDigestNow();
      const sent = Number(r?.sent);
      flash(isNaN(sent)
        ? (r?.message || 'Digest sent.')
        : `Digest sent to ${sent} chat${sent === 1 ? '' : 's'}.`);
      const a = await getBotActivity(50).catch(() => null);
      if (Array.isArray(a)) setActivity(a);
    } catch (e) {
      flash(e.message || 'Could not send the digest', true);
    }
    setBusy(false);
  }

  async function handleRefreshActivity() {
    setRefreshingActivity(true);
    try {
      const a = await getBotActivity(50);
      setActivity(Array.isArray(a) ? a : []);
    } catch (e) {
      flash(e.message || 'Could not load activity', true);
    }
    setRefreshingActivity(false);
  }

  if (loading) {
    return <div className="loading-page"><div className="spinner" /> Loading admin...</div>;
  }

  const configured = !!status?.configured;
  const running = !!status?.running;
  const stateColor = !configured ? 'var(--text-muted)' : running ? 'var(--green)' : 'var(--yellow)';
  const stateText = !configured
    ? 'Bot not configured'
    : running
      ? `Running as @${status?.username || 'unknown'}`
      : 'Configured, but not running';
  const counts = system?.counts || {};
  const codeExpired = !!codeExpiresAt && secondsLeft <= 0;

  return (
    <div>
      <div className="page-header">
        <h2>Admin</h2>
        <p>Run the system behind the budget — the Telegram bot, the daily digest, and server health</p>
      </div>

      {msg && (
        <div className="card" style={{ borderLeft: '3px solid var(--green)', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
          <CheckCircle size={16} style={{ color: 'var(--green)', flexShrink: 0 }} />
          <span style={{ fontSize: '0.85rem' }}>{msg}</span>
        </div>
      )}
      {err && (
        <div className="card" style={{ borderLeft: '3px solid var(--red)', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
          <AlertTriangle size={16} style={{ color: 'var(--red)', flexShrink: 0 }} />
          <span style={{ fontSize: '0.85rem' }}>{err}</span>
        </div>
      )}

      {/* ===== BOT STATUS ===== */}
      <div className="card" style={{ marginBottom: '1rem', borderLeft: `3px solid ${stateColor}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.25rem' }}>
              <Bot size={14} /> Telegram bot
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span style={{
                width: 9, height: 9, borderRadius: '50%', background: stateColor, flexShrink: 0,
              }} />
              <span style={{ fontSize: '1.35rem', fontWeight: 700, lineHeight: 1.2, color: 'var(--text)', wordBreak: 'break-word' }}>
                {stateText}
              </span>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
              Last poll {fmtRelative(status?.last_poll_at)}
              {' · '}{fmtNum(status?.poll_failures || 0)} poll failure{(status?.poll_failures || 0) === 1 ? '' : 's'}
              {status?.started_at ? ` · up since ${fmtDateTime(status.started_at)}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
            <div>
              <div className="stat-label">Linked chats</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{fmtNum(status?.linked_chats || 0)}</div>
            </div>
            <div>
              <div className="stat-label">Pending batches</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{fmtNum(status?.pending_batches || 0)}</div>
            </div>
            <div>
              <div className="stat-label">Claude key</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: status?.ai_configured ? 'var(--green)' : 'var(--text-muted)' }}>
                {status?.ai_configured ? 'Set' : 'Missing'}
              </div>
            </div>
          </div>
        </div>

        {status?.last_error && (
          <div style={{
            marginTop: '0.85rem', padding: '0.6rem 0.7rem', borderRadius: 6,
            background: 'var(--red-bg)', display: 'flex', gap: '0.5rem', alignItems: 'flex-start',
          }}>
            <AlertTriangle size={15} style={{ color: 'var(--red)', flexShrink: 0, marginTop: 2 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--red)' }}>Last error</div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text)', wordBreak: 'break-word', fontFamily: 'monospace' }}>
                {String(status.last_error)}
              </div>
            </div>
          </div>
        )}

        {!configured && (
          <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
            <div className="card-title"><Terminal size={14} /> Set it up</div>
            <ol style={{ fontSize: '0.82rem', color: 'var(--text)', paddingLeft: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <li>In Telegram, message <strong>@BotFather</strong> and send <code>/newbot</code>. Give it a name and a username.</li>
              <li>BotFather replies with a token. Copy it.</li>
              <li>
                Add it to your <code>.env</code> next to <code>docker-compose.yml</code>:
                <div style={{
                  marginTop: '0.35rem', padding: '0.5rem 0.6rem', borderRadius: 6, background: 'var(--bg)',
                  border: '1px solid var(--border)', fontFamily: 'monospace', fontSize: '0.78rem',
                  overflowX: 'auto', whiteSpace: 'pre',
                }}>TELEGRAM_BOT_TOKEN=123456:ABC-your-token-here</div>
              </li>
              <li>
                Bring the stack back up so the new environment is picked up:
                <div style={{
                  marginTop: '0.35rem', padding: '0.5rem 0.6rem', borderRadius: 6, background: 'var(--bg)',
                  border: '1px solid var(--border)', fontFamily: 'monospace', fontSize: '0.78rem',
                  overflowX: 'auto', whiteSpace: 'pre',
                }}>docker compose up -d</div>
                <div style={{ fontSize: '0.76rem', color: 'var(--yellow)', marginTop: '0.35rem', display: 'flex', gap: '0.4rem', alignItems: 'flex-start' }}>
                  <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>
                    Use <code>up -d</code>, <strong>not</strong> <code>restart</code>. A restart reuses the old
                    environment, so the container never sees the new token.
                  </span>
                </div>
              </li>
              <li>This page will show "Running as @yourbot" within a few seconds of the server coming back.</li>
            </ol>
          </div>
        )}
      </div>

      {/* ===== CONNECT A PHONE ===== */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="card-title"><Smartphone size={14} /> Connect a phone</div>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
          Generate a one-time code, then send it to the bot from the phone you want to link. Each code
          links one chat to one household member.
        </p>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 180px' }}>
            <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Link to which user</label>
            <select className="form-select" value={linkUser} onChange={e => setLinkUser(e.target.value)}>
              {users.length === 0 && <option value="">No users found</option>}
              {users.map(u => (
                <option key={u.id} value={u.id}>{u.display_name || u.username || `User ${u.id}`}</option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" onClick={handleGenerateCode} disabled={busy || !configured}>
            <Link2 size={15} /> Generate link code
          </button>
        </div>
        {!configured && (
          <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
            Set the bot token first — there's nothing to send a code to yet.
          </div>
        )}

        {linkCode?.code && (
          <div style={{
            marginTop: '1rem', padding: '0.9rem', borderRadius: 8, background: 'var(--bg)',
            border: `1px solid ${codeExpired ? 'var(--border)' : 'var(--accent)'}`,
          }}>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
              Code for <strong style={{ color: 'var(--text)' }}>{linkCode.display_name || 'that user'}</strong>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
              <div style={{
                fontFamily: 'monospace', fontSize: '1.9rem', fontWeight: 700, letterSpacing: '0.08em',
                color: codeExpired ? 'var(--text-muted)' : 'var(--text)', wordBreak: 'break-all',
                textDecoration: codeExpired ? 'line-through' : 'none',
              }}>
                {linkCode.code}
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => handleCopy(linkCode.code)} type="button">
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            {copyFailed && (
              <div style={{ fontSize: '0.76rem', color: 'var(--yellow)', marginTop: '0.4rem', display: 'flex', gap: '0.4rem', alignItems: 'flex-start' }}>
                <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>
                  Your browser wouldn't let this page copy (clipboard access needs HTTPS).
                  Select the code above and copy it by hand.
                </span>
              </div>
            )}

            <div style={{ fontSize: '0.82rem', color: 'var(--text)', marginTop: '0.7rem' }}>
              On the phone: open Telegram, find
              {status?.username ? <strong> @{status.username}</strong> : ' your bot'}, and send
              <span style={{
                fontFamily: 'monospace', background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 4, padding: '1px 5px', marginLeft: 4, whiteSpace: 'nowrap',
              }}>/link {linkCode.code}</span>
            </div>

            <div style={{ fontSize: '0.74rem', color: codeExpired ? 'var(--red)' : 'var(--text-muted)', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <Clock size={12} />
              {codeExpired
                ? 'This code has expired — generate another.'
                : secondsLeft > 0
                  ? `Expires in ${Math.floor(secondsLeft / 60)}m ${String(secondsLeft % 60).padStart(2, '0')}s`
                  : `Expires in ${Number(linkCode.expires_in_minutes) || 30} minutes`}
            </div>
          </div>
        )}
      </div>

      {/* ===== CONNECTED CHATS ===== */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="card-title"><Link2 size={14} /> Connected chats</div>
        {links.length === 0 ? (
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            No phones connected yet. Generate a link code above and send it to the bot from Telegram —
            linked chats can then log expenses by message or screenshot.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Telegram</th>
                  <th>Linked</th>
                  <th>Last seen</th>
                  <th>Digest</th>
                  <th>Alerts</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {links.map(l => (
                  <tr key={l.id}>
                    <td style={{ fontSize: '0.82rem', fontWeight: 600 }}>
                      {l.display_name || `User ${l.user_id ?? '?'}`}
                      {!l.active && <span className="tag" style={{ marginLeft: 6 }}>inactive</span>}
                    </td>
                    <td style={{ fontSize: '0.8rem' }}>
                      {l.telegram_username ? `@${l.telegram_username}` : (l.first_name || '—')}
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                        chat {l.chat_id || '—'}
                      </div>
                    </td>
                    <td style={{ fontSize: '0.76rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmtDateTime(l.linked_at)}</td>
                    <td style={{ fontSize: '0.76rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmtRelative(l.last_seen_at)}</td>
                    <td>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.74rem', cursor: 'pointer' }}>
                        <input type="checkbox" checked={!!l.digest_enabled} disabled={busy}
                          onChange={() => handleToggleLink(l, 'digest_enabled')} />
                        {l.digest_enabled ? 'On' : 'Off'}
                      </label>
                    </td>
                    <td>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.74rem', cursor: 'pointer' }}>
                        <input type="checkbox" checked={!!l.alerts_enabled} disabled={busy}
                          onChange={() => handleToggleLink(l, 'alerts_enabled')} />
                        {l.alerts_enabled ? 'On' : 'Off'}
                      </label>
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm" title="Unlink" disabled={busy}
                        onClick={() => handleUnlink(l)}>
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ===== DAILY DIGEST ===== */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="card-title"><CalendarClock size={14} /> Daily digest</div>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
          One message a day to every linked chat with digest turned on — yesterday's spending, the
          offset, and what's coming up.
        </p>

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.85rem' }}>
          <span className={`tag ${status?.digest_enabled ? 'tag-green' : ''}`}>
            {status?.digest_enabled ? 'Enabled' : 'Disabled'}
          </span>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Schedule:{' '}
            <span style={{ fontFamily: 'monospace', color: 'var(--text)' }}>{status?.digest_cron || 'not set'}</span>
            {cronToTime(status?.digest_cron) ? ` (daily at ${cronToTime(status?.digest_cron)})` : ''}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '0 1 150px' }}>
            <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Send each day at</label>
            <input className="form-input" type="time" value={digestTime}
              onChange={e => setDigestTime(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={() => handleSaveDigest(false)} disabled={busy}>
            Save time
          </button>
          <button className="btn btn-ghost" onClick={handleToggleDigest} disabled={busy}>
            {status?.digest_enabled ? 'Turn off' : 'Turn on'}
          </button>
          <button className="btn btn-success" onClick={handleSendNow} disabled={busy || !configured}>
            <Send size={15} /> Send now
          </button>
        </div>

        <button className="btn btn-ghost btn-sm" type="button" style={{ marginTop: '0.75rem' }}
          onClick={() => setShowAdvanced(v => !v)}>
          {showAdvanced ? 'Hide' : 'Show'} advanced (raw cron)
        </button>

        {showAdvanced && (
          <div style={{ marginTop: '0.6rem', paddingTop: '0.6rem', borderTop: '1px solid var(--border)' }}>
            <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>
              Raw cron expression — advanced. Five fields: minute hour day month weekday.
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <input className="form-input" style={{ flex: '1 1 180px', fontFamily: 'monospace' }}
                value={rawCron} onChange={e => setRawCron(e.target.value)} placeholder="0 8 * * *" />
              <button className="btn btn-ghost" onClick={() => handleSaveDigest(true)} disabled={busy}>
                Save cron
              </button>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
              e.g. <span style={{ fontFamily: 'monospace' }}>0 8 * * 1-5</span> for weekday mornings. The
              server rejects anything it can't parse.
            </div>
          </div>
        )}
      </div>

      {/* ===== SYSTEM ===== */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="card-title"><Server size={14} /> System</div>
        <div className="stat-grid" style={{ marginBottom: '0.85rem' }}>
          <div className="stat-card">
            <div className="stat-label">Version</div>
            <div className="stat-value" style={{ fontSize: '1.1rem' }}>{system?.version || '—'}</div>
            <div className="card-sub">Uptime {fmtUptime(system?.uptime_seconds)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Node</div>
            <div className="stat-value" style={{ fontSize: '1.1rem' }}>{system?.node || '—'}</div>
            <div className="card-sub">Postgres {system?.postgres || '—'}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Database</div>
            <div className="stat-value" style={{ fontSize: '1.1rem' }}>{system?.database_size || '—'}</div>
            <div className="card-sub">
              {system?.started_at ? `Started ${fmtDateTime(system.started_at)}` : 'Start time unknown'}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Claude API key</div>
            <div className={`stat-value ${system?.ai_configured ? 'positive' : 'warning'}`} style={{ fontSize: '1.1rem' }}>
              {system?.ai_configured ? 'Configured' : 'Not set'}
            </div>
            <div className="card-sub">
              {system?.ai_configured ? 'Screenshots and advice available' : 'ANTHROPIC_API_KEY missing'}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Latest expense</div>
            <div className="stat-value" style={{ fontSize: '1.1rem' }}>{fmtDate(system?.latest_expense_date)}</div>
            <div className="card-sub">Most recent row in expenses</div>
          </div>
        </div>

        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.4rem' }}>
          Row counts
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
          {Object.keys(COUNT_LABELS).map(key => (
            <div key={key} style={{
              padding: '0.4rem 0.6rem', borderRadius: 6, background: 'var(--bg)',
              border: '1px solid var(--border)', minWidth: 110,
            }}>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{COUNT_LABELS[key]}</div>
              <div style={{ fontSize: '0.95rem', fontWeight: 700 }}>
                {counts[key] === null || counts[key] === undefined
                  ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>n/a</span>
                  : fmtNum(counts[key])}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ===== ACTIVITY LOG ===== */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <div className="card-title" style={{ marginBottom: 0 }}><Activity size={14} /> Bot activity</div>
          <button className="btn btn-ghost btn-sm" onClick={handleRefreshActivity} disabled={refreshingActivity}>
            <RefreshCw size={13} /> {refreshingActivity ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {activity.length === 0 ? (
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '0.6rem' }}>
            Nothing logged yet. Messages in and out of the bot show up here once a phone is connected.
          </p>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto', marginTop: '0.6rem' }}>
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>What</th>
                  <th>Who</th>
                  <th style={{ textAlign: 'right' }}>When</th>
                </tr>
              </thead>
              <tbody>
                {activity.map(a => {
                  const isIn = a.direction === 'in';
                  const color = isIn ? 'var(--blue)' : 'var(--green)';
                  return (
                    <tr key={a.id}>
                      <td style={{ width: 28 }}>
                        <span title={isIn ? 'Inbound' : 'Outbound'} style={{ color, display: 'inline-flex' }}>
                          {isIn ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                        </span>
                      </td>
                      <td style={{ fontSize: '0.8rem' }}>
                        <span style={{ color, fontWeight: 600, fontSize: '0.72rem' }}>{a.kind || 'message'}</span>
                        <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem', wordBreak: 'break-word' }}>
                          {a.summary || '—'}
                        </div>
                      </td>
                      <td style={{ fontSize: '0.76rem', whiteSpace: 'nowrap' }}>
                        {a.display_name || (a.chat_id ? `chat ${a.chat_id}` : '—')}
                      </td>
                      <td style={{ fontSize: '0.74rem', color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap' }}
                        title={fmtDateTime(a.created_at)}>
                        {fmtRelative(a.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
