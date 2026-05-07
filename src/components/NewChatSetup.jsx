import { useState, useEffect } from 'react';
import { apiFetch } from '../utils/api';
import './NewChatSetup.css';

const PERM_HINTS = {
  plan: "Claude will analyze and plan but won't make any changes. Safest for mobile use.",
  acceptEdits: 'Claude can edit files automatically, but bash/shell commands will be denied.',
  auto: '⚠️ Claude will approve ALL actions automatically, including running commands. Use with caution.',
  default: 'Tools requiring permission will be denied in non-interactive mode.',
};

function NotificationToggle() {
  const [permission, setPermission] = useState(
    'Notification' in window ? Notification.permission : 'unsupported'
  );

  if (permission === 'unsupported') return null;

  async function request() {
    const result = await Notification.requestPermission();
    setPermission(result);
  }

  if (permission === 'granted') {
    return <p className="ncs-notif-status ncs-notif-on">🔔 Notifications enabled</p>;
  }
  if (permission === 'denied') {
    return <p className="ncs-notif-status ncs-notif-off">🔕 Notifications blocked — enable in browser settings</p>;
  }
  return (
    <button className="ncs-notif-btn" onClick={request}>
      🔔 Enable notifications when Claude finishes
    </button>
  );
}

export default function NewChatSetup({ projectPath, permissionMode, onUpdateState }) {
  const [dirs, setDirs] = useState([]);

  useEffect(() => {
    apiFetch('/api/directories')
      .then(r => r.json())
      .then(setDirs)
      .catch(() => {});
  }, []);

  const shortDir = projectPath
    ? projectPath.split('/').filter(Boolean).slice(-2).join('/')
    : '~ (Home)';

  return (
    <div className="ncs-section">
      <h2 className="ncs-title">New Chat Setup</h2>

      <label className="ncs-label">Working Directory</label>
      <select
        className="ncs-select"
        value={projectPath || ''}
        onChange={e => onUpdateState({ projectPath: e.target.value || null })}
      >
        <option value="">~ (Home directory)</option>
        {dirs.map(d => (
          <option key={d} value={d}>{d}</option>
        ))}
      </select>

      <label className="ncs-label">Permission Mode</label>
      <select
        className="ncs-select"
        value={permissionMode}
        onChange={e => onUpdateState({ permissionMode: e.target.value })}
      >
        <option value="plan">Plan — read-only analysis, no changes</option>
        <option value="acceptEdits">Accept Edits — auto-approve file edits, deny bash</option>
        <option value="auto">Auto — approve everything automatically</option>
        <option value="default">Default — deny tools that need permission</option>
      </select>
      <p className="ncs-hint">{PERM_HINTS[permissionMode]}</p>

      <NotificationToggle />

      <div className="ncs-summary">
        <span className="ncs-ready">Ready:</span>
        <span>{shortDir} · {permissionMode} mode</span>
      </div>

      <p className="ncs-footer">Type your message below to start chatting.</p>
    </div>
  );
}
