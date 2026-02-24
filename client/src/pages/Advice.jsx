import React, { useState, useEffect } from 'react';
import { getLatestAdvice, getNightlySummary } from '../api';
import { Brain, RefreshCw } from 'lucide-react';

export default function Advice() {
  const [nightlyAdvice, setNightlyAdvice] = useState(null);
  const [paydayAdvice, setPaydayAdvice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    Promise.all([getLatestAdvice('nightly'), getLatestAdvice('payday')])
      .then(([n, p]) => { setNightlyAdvice(n); setPaydayAdvice(p); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const result = await getNightlySummary();
      setNightlyAdvice({ content: result.summary, advice_type: 'nightly', created_at: new Date().toISOString() });
    } catch (err) { alert(err.message); }
    setRefreshing(false);
  }

  if (loading) return <div className="loading-page"><div className="spinner" /></div>;

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>Claude Advice</h2>
          <p>AI-powered financial analysis refreshed nightly at 9pm AEST</p>
        </div>
        <button className="btn btn-primary" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? <><div className="spinner" /> Generating...</> : <><RefreshCw size={16} /> Generate Now</>}
        </button>
      </div>

      <div className="advice-box">
        <h3><Brain size={16} style={{ marginRight: 4 }} /> Nightly Spending Summary</h3>
        {nightlyAdvice?.created_at && (
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            Generated: {new Date(nightlyAdvice.created_at).toLocaleString('en-AU')}
          </div>
        )}
        {nightlyAdvice?.content || 'No nightly summary yet. Click "Generate Now" or wait for the 9pm AEST auto-run.'}
      </div>

      {paydayAdvice?.content && (
        <div className="advice-box" style={{ borderColor: 'rgba(0, 206, 201, 0.3)', background: 'linear-gradient(135deg, rgba(0, 206, 201, 0.1), rgba(108, 92, 231, 0.05))' }}>
          <h3 style={{ color: 'var(--green)' }}>Latest Pay Day Advice</h3>
          {paydayAdvice?.created_at && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
              Generated: {new Date(paydayAdvice.created_at).toLocaleString('en-AU')}
            </div>
          )}
          {paydayAdvice.content}
        </div>
      )}

      <div className="card">
        <div className="card-title">How Claude Advice Works</div>
        <ul style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.8, paddingLeft: '1.25rem' }}>
          <li><strong>Nightly Summary</strong> runs automatically at 9pm AEST. It reviews all spending in the last 30 days, compares against Sydney benchmarks, and checks your savings goal progress.</li>
          <li><strong>Pay Day Advice</strong> is generated when you use the "Pay Day" page. It factors in your goals, levers, current balances, upcoming bulge expenses, and recent spending to suggest exact fund allocations.</li>
          <li>Both analyses use your set allocation levers and savings goals as context.</li>
          <li>You can always click "Generate Now" for a fresh analysis.</li>
          <li>Claude needs your ANTHROPIC_API_KEY to be configured in the server environment.</li>
        </ul>
      </div>
    </div>
  );
}
