import React, { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

const API = '';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (payload.exp * 1000 < Date.now()) {
          logout();
        } else {
          setUser(payload);
          localStorage.setItem('token', token);
        }
      } catch {
        logout();
      }
    }
    setLoading(false);
  }, [token]);

  async function login(username, password) {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Login failed');
    }
    const data = await res.json();
    setToken(data.token);
    setUser(data.user);
    localStorage.setItem('token', data.token);
    return data.user;
  }

  async function register(formData) {
    const res = await fetch(`${API}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Registration failed');
    }
    const data = await res.json();
    setToken(data.token);
    setUser(data.user);
    localStorage.setItem('token', data.token);
    return data.user;
  }

  function logout() {
    setUser(null);
    setToken(null);
    localStorage.removeItem('token');
  }

  async function updateProfile(profileData) {
    const res = await fetch(`${API}/api/auth/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(profileData)
    });
    if (!res.ok) throw new Error('Profile update failed');
    const updated = await res.json();
    setUser(prev => ({ ...prev, ...updated }));
    return updated;
  }

  async function changePassword(current_password, new_password) {
    const res = await fetch(`${API}/api/auth/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ current_password, new_password })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Password change failed');
    }
  }

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, updateProfile, changePassword }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
