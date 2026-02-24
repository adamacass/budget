import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Expenses from './pages/Expenses';
import PayDay from './pages/PayDay';
import Goals from './pages/Goals';
import Projections from './pages/Projections';
import Settings from './pages/Settings';
import Advice from './pages/Advice';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-page"><div className="spinner" /> Loading...</div>;
  if (!user) return <Navigate to="/login" />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Dashboard />} />
        <Route path="expenses" element={<Expenses />} />
        <Route path="payday" element={<PayDay />} />
        <Route path="goals" element={<Goals />} />
        <Route path="projections" element={<Projections />} />
        <Route path="advice" element={<Advice />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
