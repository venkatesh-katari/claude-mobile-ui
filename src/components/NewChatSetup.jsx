import { useMemo, useState, useEffect } from 'react';
import { Check } from 'lucide-react';
import { apiFetch } from '../utils/api';
import './NewChatSetup.css';

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
      🔔 Enable notifications when the agent finishes
    </button>
  );
}

export default function NewChatSetup({ backend, backends, model, projectPath, permissionMode, onUpdateState }) {
  const [dirs, setDirs] = useState([]);

  useEffect(() => {
    apiFetch('/api/directories')
      .then(response => response.ok ? response.json() : Promise.reject())
      .then(setDirs)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!backends.length || backends.some(item => item.id === backend && item.available)) return;
    const fallback = backends.find(item => item.available);
    if (fallback) {
      onUpdateState({
        backend: fallback.id,
        model: fallback.defaultModel,
        permissionMode: fallback.defaultPermissionMode,
      });
    }
  }, [backend, backends, onUpdateState]);

  const selectedBackend = useMemo(
    () => backends.find(item => item.id === backend),
    [backend, backends]
  );

  const dirOptions = [{ value: '', label: '~ (Home directory)' }, ...dirs.map(d => ({ value: d, label: d }))];
  const backendOptions = backends
    .filter(item => item.available)
    .map(item => ({ value: item.id, label: item.label }));
  const modelOptions = (selectedBackend?.models || []).map(item => ({
    value: item.value,
    label: item.description ? `${item.label} — ${item.description}` : item.label,
  }));
  const permissionOptions = (selectedBackend?.permissionModes || []).map(item => ({
    value: item.value,
    label: item.description ? `${item.label} — ${item.description}` : item.label,
  }));
  const permissionHint = selectedBackend?.permissionModes.find(item => item.value === permissionMode)?.description;

  return (
    <div className="ncs-section">
      <h2 className="ncs-title">New Chat Setup</h2>

      <label className="ncs-label">Backend</label>
      <ResponsiveSelect
        label="Backend"
        value={backend}
        options={backendOptions}
        onChange={value => {
          const next = backends.find(item => item.id === value);
          if (!next) return;
          onUpdateState({
            backend: next.id,
            model: next.defaultModel,
            permissionMode: next.defaultPermissionMode,
          });
        }}
      />

      <label className="ncs-label">Working Directory</label>
      <ResponsiveSelect
        label="Working Directory"
        value={projectPath || ''}
        options={dirOptions}
        onChange={v => onUpdateState({ projectPath: v || null })}
      />

      {modelOptions.length > 0 && (
        <>
          <label className="ncs-label">Model</label>
          <ResponsiveSelect
            label="Model"
            value={model}
            options={modelOptions}
            onChange={value => onUpdateState({ model: value })}
          />
        </>
      )}

      <label className="ncs-label">Permission Mode</label>
      <ResponsiveSelect
        label="Permission Mode"
        value={permissionMode}
        options={permissionOptions}
        onChange={v => onUpdateState({ permissionMode: v })}
      />
      {permissionHint && <p className="ncs-hint">{permissionHint}</p>}

      <NotificationToggle />

      <p className="ncs-footer">Type your message below to start chatting.</p>
    </div>
  );
}
