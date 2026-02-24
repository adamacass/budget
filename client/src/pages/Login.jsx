import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [grossIncome, setGrossIncome] = useState('');
  const [payCycle, setPayCycle] = useState('fortnightly');
  const [superRate, setSuperRate] = useState('11.5');
  const [hecsRate, setHecsRate] = useState('0');
  const [error, setError] = useState('');
  const { login, register } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      if (isRegister) {
        await register({
          username,
          password,
          display_name: displayName,
          gross_income: parseFloat(grossIncome) || 0,
          pay_cycle: payCycle,
          super_rate: parseFloat(superRate) / 100 || 0.115,
          hecs_repayment_rate: parseFloat(hecsRate) / 100 || 0
        });
      } else {
        await login(username, password);
      }
      navigate('/');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Budget Tracker</h1>
        <p className="subtitle">Household Finance for Two</p>

        {error && <div className="error-msg">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Username</label>
            <input className="form-input" value={username} onChange={e => setUsername(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input className="form-input" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
          </div>

          {isRegister && (
            <>
              <div className="form-group">
                <label>Display Name</label>
                <input className="form-input" value={displayName} onChange={e => setDisplayName(e.target.value)} required />
              </div>
              <div className="form-group">
                <label>Gross Income (p.a. incl super)</label>
                <input className="form-input" type="number" value={grossIncome} onChange={e => setGrossIncome(e.target.value)} placeholder="e.g. 159000" />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Pay Cycle</label>
                  <select className="form-select" value={payCycle} onChange={e => setPayCycle(e.target.value)}>
                    <option value="weekly">Weekly</option>
                    <option value="fortnightly">Fortnightly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Super Rate %</label>
                  <input className="form-input" type="number" step="0.1" value={superRate} onChange={e => setSuperRate(e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label>HECS Repayment Rate %</label>
                <input className="form-input" type="number" step="0.1" value={hecsRate} onChange={e => setHecsRate(e.target.value)} placeholder="e.g. 6" />
              </div>
            </>
          )}

          <button className="btn btn-primary" style={{ width: '100%', marginTop: '0.5rem' }}>
            {isRegister ? 'Create Account' : 'Sign In'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: '1rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.8rem' }}
            onClick={() => { setIsRegister(!isRegister); setError(''); }}
          >
            {isRegister ? 'Sign in' : 'Register'}
          </button>
        </p>
      </div>
    </div>
  );
}
