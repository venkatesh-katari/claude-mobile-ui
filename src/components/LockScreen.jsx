import { useState } from 'react';
import { setPin } from '../utils/api';
import './LockScreen.css';

export default function LockScreen({ onUnlock }) {
  const [pin, setLocalPin] = useState('');
  const [error, setError] = useState('');
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!pin.trim() || loading) return;
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/check', {
        headers: { 'X-Pin': pin.trim() },
      });

      let data = {};
      try { data = await res.json(); } catch {}

      if (res.ok && data.ok) {
        setPin(pin.trim());
        onUnlock();
      } else if (res.status === 429) {
        setLocked(true);
        setError(data.error || 'Too many attempts. Try again later.');
      } else if (res.status === 401) {
        const left = data.attemptsLeft ?? '';
        setError(`Incorrect PIN.${left ? ` ${left} attempt${left === 1 ? '' : 's'} left.` : ''}`);
        setLocalPin('');
      } else {
        setError('Could not reach server. Please try again.');
      }
    } catch {
      setError('Could not reach server.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ls-overlay">
      <div className="ls-card">
        <div className="ls-icon">🔒</div>
        <h1 className="ls-title">Claude Mobile</h1>
        <p className="ls-subtitle">Enter PIN to continue</p>

        <form className="ls-form" onSubmit={handleSubmit}>
          <input
            className={`ls-input ${error ? 'error' : ''}`}
            type="password"
            inputMode="numeric"
            placeholder="PIN"
            value={pin}
            onChange={e => { setLocalPin(e.target.value); setError(''); }}
            disabled={locked || loading}
            autoFocus
            autoComplete="off"
          />
          {error && <p className="ls-error">{error}</p>}
          <button
            className="ls-btn"
            type="submit"
            disabled={!pin.trim() || locked || loading}
          >
            {loading ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  );
}
