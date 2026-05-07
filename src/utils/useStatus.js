import { useState, useEffect, useRef } from 'react';
import { apiFetch } from './api';

// Polls /api/status every INTERVAL ms, faster when busy
const IDLE_INTERVAL = 15_000;
const BUSY_INTERVAL = 3_000;

export function useStatus() {
  const [status, setStatus] = useState({ activeSessions: 0, maxSessions: 2, busy: false });
  const timerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await apiFetch('/api/status');
        if (!cancelled && res.ok) {
          const data = await res.json();
          setStatus(data);
          timerRef.current = setTimeout(poll, data.busy ? BUSY_INTERVAL : IDLE_INTERVAL);
        }
      } catch {
        if (!cancelled) timerRef.current = setTimeout(poll, IDLE_INTERVAL);
      }
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
    };
  }, []);

  return status;
}
