import { useState, useEffect } from 'react';
import { Check } from 'lucide-react';
import { apiFetch } from '../utils/api';
import './NewChatSetup.css';

const PERM_HINTS = {
  plan: "Claude will analyze and plan but won't make any changes. Safest for mobile use.",
  acceptEdits: 'Claude can edit files automatically, but bash/shell commands will be denied.',
  auto: '⚠️ Claude will approve ALL actions automatically, including running commands. Use with caution.',
  default: 'Tools requiring permission will be denied in non-interactive mode.',
};

// Native <select> on desktop (mouse/keyboard dropdown); on touch devices the
// native picker renders as an awkward anchored list, so we swap in the app's
// own bottom sheet there instead. Both are always in the DOM — CSS (`@media
// (hover: none)`) decides which one is visible, no device sniffing in JS.
function ResponsiveSelect({ label, value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const current = options.find(o => o.value === value);

  return (
    <>
      <select
        className="ncs-select ncs-select-native"
        value={value}
        onChange={e => onChange(e.target.value)}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      <button type="button" className="ncs-select ncs-select-trigger" onClick={() => setOpen(true)}>
        <span>{current?.label}</span>
      </button>

      {open && (
        <div className="cv-menu-overlay" onClick={() => setOpen(false)}>
          <div className="cv-menu-sheet" onClick={e => e.stopPropagation()}>
            <div className="cv-menu-handle" />
            <div className="cv-menu-section-label">{label}</div>
            {options.map(o => (
              <button
                key={o.value}
                className={`cv-menu-item ${o.value === value ? 'active' : ''}`}
                onClick={() => { onChange(o.value); setOpen(false); }}
              >
                <span className="cv-menu-item-label">{o.label}</span>
                {o.value === value && <Check size={14} className="cv-menu-check" />}
              </button>
            ))}
            <button className="cv-menu-cancel" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

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

const PERM_OPTIONS = [
  { value: 'plan', label: 'Plan — read-only analysis, no changes' },
  { value: 'acceptEdits', label: 'Accept Edits — auto-approve file edits, deny bash' },
  { value: 'auto', label: 'Auto — approve everything automatically' },
  { value: 'default', label: 'Default — deny tools that need permission' },
];

export default function NewChatSetup({ projectPath, permissionMode, onUpdateState }) {
  const [dirs, setDirs] = useState([]);

  useEffect(() => {
    apiFetch('/api/directories')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setDirs)
      .catch(() => {});
  }, []);

  const dirOptions = [{ value: '', label: '~ (Home directory)' }, ...dirs.map(d => ({ value: d, label: d }))];

  return (
    <div className="ncs-section">
      <h2 className="ncs-title">New Chat Setup</h2>

      <label className="ncs-label">Working Directory</label>
      <ResponsiveSelect
        label="Working Directory"
        value={projectPath || ''}
        options={dirOptions}
        onChange={v => onUpdateState({ projectPath: v || null })}
      />

      <label className="ncs-label">Permission Mode</label>
      <ResponsiveSelect
        label="Permission Mode"
        value={permissionMode}
        options={PERM_OPTIONS}
        onChange={v => onUpdateState({ permissionMode: v })}
      />
      <p className="ncs-hint">{PERM_HINTS[permissionMode]}</p>

      <NotificationToggle />

      <p className="ncs-footer">Type your message below to start chatting.</p>
    </div>
  );
}
