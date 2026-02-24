import React from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LayoutDashboard, Receipt, Wallet, Target, TrendingUp, Brain, Settings, Download } from 'lucide-react';
import { exportToExcel } from '../api';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/expenses', icon: Receipt, label: 'Expenses' },
  { to: '/payday', icon: Wallet, label: 'Pay Day' },
  { to: '/goals', icon: Target, label: 'Goals & Levers' },
  { to: '/projections', icon: TrendingUp, label: 'Projections' },
  { to: '/advice', icon: Brain, label: 'Claude Advice' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();

  return (
    <div className="app-layout">
      <nav className="sidebar">
        <div className="sidebar-brand">
          <h1>Budget Tracker</h1>
          <p>Household Finance</p>
        </div>

        <div className="sidebar-nav">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
            >
              <Icon />
              <span>{label}</span>
            </NavLink>
          ))}
          <button className="sidebar-link" onClick={() => exportToExcel()} title="Export to Excel">
            <Download />
            <span>Export Excel</span>
          </button>
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-user-avatar">
              {(user?.display_name || user?.username || '?')[0].toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text)' }}>{user?.display_name || user?.username}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>{user?.pay_cycle} pay</div>
            </div>
          </div>
          <button className="sidebar-logout" onClick={logout}>Sign out</button>
        </div>
      </nav>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
