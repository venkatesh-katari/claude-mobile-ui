import { useState, useEffect } from 'react';
import { apiFetch } from '../utils/api';
import GitDiffView from './GitDiffView';
import './DiffViewerPage.css';

function getInitialTheme() {
  try {
    const saved = localStorage.getItem('theme');
    if (saved) return saved;
  } catch {}
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// Bare, chrome-free diff view for the "open in new tab" feature — a
// self-contained sibling to <App>, reached via /?diffView=1&cwd=&file=
// rather than a real router (this app has none). Deliberately does not
// reuse App's PIN lock screen: the PIN travels into this tab for free via
// sessionStorage (window.open without noopener clones it), so the only
// auth case to handle here is a fresh/bookmarked open with no PIN at all.
export default function DiffViewerPage() {
  const [theme] = useState(getInitialTheme);
  const [diffText, setDiffText] = useState('');
  const [status, setStatus] = useState('loading'); // 'loading' | 'ok' | 'unauthorized' | 'error'

  const params = new URLSearchParams(window.location.search);
  const cwd = params.get('cwd') || '';
  const file = params.get('file') || '';

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!cwd || !file) { setStatus('error'); return; }
    apiFetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`)
      .then(r => {
        if (r.status === 401 || r.status === 429) { setStatus('unauthorized'); return null; }
        if (!r.ok) { setStatus('error'); return null; }
        return r.json();
      })
      .then(data => {
        if (!data) return;
        setDiffText(data.diff || '');
        setStatus('ok');
      })
      .catch(() => setStatus('error'));
  }, [cwd, file]);

  return (
    <div className="dvp-root">
      <div className="dvp-header">
        <span className="dvp-filename">{file ? file.split('/').pop() : 'Diff'}</span>
      </div>
      <div className="dvp-body">
        {status === 'loading' && <p className="dvp-message">Loading diff…</p>}
        {status === 'unauthorized' && (
          <p className="dvp-message">
            Not signed in. <a href="/">Open the app</a> first, then reload this tab.
          </p>
        )}
        {status === 'error' && <p className="dvp-message">Couldn't load this diff.</p>}
        {status === 'ok' && <GitDiffView diffText={diffText} />}
      </div>
    </div>
  );
}
