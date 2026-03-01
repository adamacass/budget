import React, { useState, useRef } from 'react';
import { Outlet } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';

export default function Home() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [pullDist, setPullDist] = useState(0);
  const startY = useRef(0);
  const pulling = useRef(false);

  function triggerRefresh() {
    setRefreshing(true);
    setRefreshKey(k => k + 1);
    setTimeout(() => { setRefreshing(false); setPullDist(0); }, 800);
  }

  function onTouchStart(e) {
    if (window.scrollY <= 5) {
      startY.current = e.touches[0].clientY;
      pulling.current = true;
    }
  }

  function onTouchMove(e) {
    if (pulling.current && startY.current > 0 && !refreshing) {
      const d = e.touches[0].clientY - startY.current;
      if (d > 0 && d < 150) {
        setPullDist(d);
        if (d > 10) e.preventDefault();
      } else if (d <= 0) {
        setPullDist(0);
        pulling.current = false;
      }
    }
  }

  function onTouchEnd() {
    if (pullDist > 60 && !refreshing) triggerRefresh();
    else setPullDist(0);
    startY.current = 0;
    pulling.current = false;
  }

  return (
    <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      {/* Pull-to-refresh indicator */}
      {(pullDist > 0 || refreshing) && (
        <div className="pull-indicator" style={{ height: refreshing ? 44 : Math.min(pullDist * 0.5, 50) }}>
          {refreshing ? (
            <><div className="spinner" /> Refreshing...</>
          ) : (
            <RefreshCw
              size={18}
              style={{
                opacity: Math.min(1, pullDist / 60),
                transform: `rotate(${pullDist * 4}deg)`,
                transition: 'none',
                color: pullDist > 60 ? 'var(--accent)' : 'var(--text-muted)'
              }}
            />
          )}
        </div>
      )}

      {/* Page content — key forces remount on refresh */}
      <div key={refreshKey}>
        <Outlet />
      </div>
    </div>
  );
}
