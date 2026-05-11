import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Sun, Moon, Search, ChevronDown, Pencil, Radio } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { useStatus } from '../utils/useStatus';
import './SessionList.css';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const diff = Date.now() - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function RenameInput({ value, sessionId, onDone }) {
  const [text, setText] = useState(value);
  const [saving, setSaving] = useState(false);

  async function save() {
    const trimmed = text.trim();
    if (!trimmed || trimmed === value) { onDone(value); return; }
    setSaving(true);
    try {
      await apiFetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: trimmed }),
      });
      onDone(trimmed);
    } catch {
      onDone(value);
    } finally {
      setSaving(false);
    }
  }

  return (
    <input
      className="sl-rename-input"
      value={text}
      autoFocus
      disabled={saving}
      onChange={e => setText(e.target.value)}
      onBlur={save}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); onDone(value); }
      }}
      onClick={e => e.stopPropagation()}
    />
  );
}

function SessionCard({ session, projectId, onOpen, onRename, renamingId, onRenameComplete, isActive }) {
  const isRenaming = renamingId === session.sessionId;
  const displayTitle = session.summary && session.summary !== '(no title)'
    ? session.summary
    : null;

  return (
    <div
      className={`sl-session-card ${isActive ? 'sl-session-active' : ''}`}
      onClick={() => !isRenaming && onOpen(session.sessionId, session.projectPath, projectId, session.summary)}
    >
      <div className="sl-session-title-row">
        {isRenaming ? (
          <RenameInput
            value={session.summary}
            sessionId={session.sessionId}
            onDone={(title) => onRenameComplete(projectId, session.sessionId, title)}
          />
        ) : (
          <>
            <span className={`sl-session-title ${!displayTitle ? 'sl-session-title-empty' : ''}`}>
              {displayTitle || 'Untitled session'}
            </span>
            {isActive && (
              <span className="sl-active-badge" title="Running on another device">
                <Radio size={10} />
                Live
              </span>
            )}
            <button
              className="sl-rename-btn"
              title="Rename"
              onClick={e => { e.stopPropagation(); onRename(session.sessionId); }}
            >
              <Pencil size={12} />
            </button>
          </>
        )}
      </div>
      <div className="sl-session-meta">
        <span>{session.gitBranch || formatDate(session.modified || session.created)}</span>
        {session.gitBranch && <span>{formatDate(session.modified || session.created)}</span>}
      </div>
    </div>
  );
}

export default function SessionList({ onOpenSession, onNewChat, theme, onToggleTheme }) {
  const [projects, setProjects] = useState([]);
  const [expanded, setExpanded] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState(null);
  const [activeSessionIds, setActiveSessionIds] = useState(new Set());
  const [conflictSession, setConflictSession] = useState(null); // { sessionId, projectPath, projectId, summary }
  const status = useStatus();

  useEffect(() => { loadProjects(); }, []);

  // Refresh active sessions every 5 seconds
  useEffect(() => {
    function fetchActive() {
      apiFetch('/api/sessions/active')
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(ids => setActiveSessionIds(new Set(ids)))
        .catch(() => {});
    }
    fetchActive();
    const interval = setInterval(fetchActive, 5000);
    return () => clearInterval(interval);
  }, []);

  async function loadProjects() {
    setLoadError(false);
    try {
      const res = await apiFetch('/api/projects');
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const projs = await res.json();
      const loaded = [];
      for (const proj of projs) {
        const sessRes = await apiFetch(`/api/projects/${encodeURIComponent(proj.id)}/sessions`);
        if (!sessRes.ok) continue; // skip broken project, keep loading others
        const sessions = await sessRes.json();
        if (sessions.length === 0) continue;
        loaded.push({ ...proj, sessions });
      }
      setProjects(loaded);

      // Auto-expand the most recently modified project
      if (loaded.length > 0) {
        const mostRecent = loaded.reduce((best, p) => {
          const t = new Date(p.sessions[0]?.modified || 0);
          return t > new Date(best.sessions[0]?.modified || 0) ? p : best;
        });
        setExpanded(new Set([mostRecent.id]));
      }
    } catch (err) {
      console.error('Failed to load projects:', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  function toggleProject(id) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const handleOpenSession = useCallback((sessionId, projectPath, projectId, summary) => {
    if (activeSessionIds.has(sessionId)) {
      setConflictSession({ sessionId, projectPath, projectId, summary });
    } else {
      onOpenSession(sessionId, projectPath, projectId, summary);
    }
  }, [activeSessionIds, onOpenSession]);

  const handleRenameComplete = useCallback((projectId, sessionId, newTitle) => {
    setProjects(prev => prev.map(p =>
      p.id !== projectId ? p : {
        ...p,
        sessions: p.sessions.map(s => s.sessionId === sessionId ? { ...s, summary: newTitle } : s),
      }
    ));
    setRenamingId(null);
  }, []);

  const totalSessions = useMemo(() => projects.reduce((n, p) => n + p.sessions.length, 0), [projects]);
  const showSearch = totalSessions >= 10;

  // Flat recent sessions — latest 5 across all projects
  const recentSessions = useMemo(() => {
    const all = projects.flatMap(p => p.sessions.map(s => ({ ...s, projectId: p.id })));
    return all.sort((a, b) => new Date(b.modified || b.created) - new Date(a.modified || a.created)).slice(0, 5);
  }, [projects]);

  const query = search.toLowerCase().trim();
  const filtered = query
    ? projects.map(p => ({ ...p, sessions: p.sessions.filter(s => s.summary.toLowerCase().includes(query)) })).filter(p => p.sessions.length > 0)
    : projects;
  const displayExpanded = query ? new Set(filtered.map(p => p.id)) : expanded;

  return (
    <div className="sl-container">

      {/* Conflict bottom sheet */}
      {conflictSession && (
        <div className="sl-conflict-overlay" onClick={() => setConflictSession(null)}>
          <div className="sl-conflict-sheet" onClick={e => e.stopPropagation()}>
            <div className="sl-conflict-handle" />
            <div className="sl-conflict-icon">⚠️</div>
            <h3 className="sl-conflict-title">Session is active on desktop</h3>
            <p className="sl-conflict-body">
              Claude is currently running in <strong>{conflictSession.summary || 'this session'}</strong> on another window or device. Opening it here at the same time will corrupt the conversation history.
            </p>
            <button
              className="sl-conflict-btn sl-conflict-takeover"
              onClick={async () => {
                try {
                  const res = await apiFetch(`/api/sessions/${conflictSession.sessionId}/takeover`, { method: 'POST' });
                  if (!res.ok) throw new Error();
                } catch {
                  // Takeover failed — don't open; show the sheet again with updated state
                  setConflictSession(null);
                  return;
                }
                setActiveSessionIds(prev => { const n = new Set(prev); n.delete(conflictSession.sessionId); return n; });
                onOpenSession(conflictSession.sessionId, conflictSession.projectPath, conflictSession.projectId, conflictSession.summary);
                setConflictSession(null);
              }}
            >
              Take Over — stop desktop &amp; continue here
            </button>
            <button
              className="sl-conflict-btn sl-conflict-anyway"
              onClick={() => {
                onOpenSession(conflictSession.sessionId, conflictSession.projectPath, conflictSession.projectId, conflictSession.summary);
                setConflictSession(null);
              }}
            >
              Continue Anyway (risk corruption)
            </button>
            <button
              className="sl-conflict-btn sl-conflict-cancel"
              onClick={() => setConflictSession(null)}
            >
              Go Back
            </button>
          </div>
        </div>
      )}

      <div className="sl-header">
        <h1>Claude</h1>
        <div className="sl-header-actions">
          <button className="sl-theme-btn" onClick={onToggleTheme} title="Toggle theme">
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className="sl-new-btn" onClick={onNewChat}>
            <Plus size={14} strokeWidth={2.5} />
            New chat
          </button>
        </div>
      </div>

      {status.busy && (
        <div className="sl-busy-banner">
          ⏳ Claude is busy — {status.activeSessions}/{status.maxSessions} sessions active
        </div>
      )}

      {showSearch && (
        <div className="sl-search-bar">
          <div className="sl-search-wrap">
            <Search size={14} className="sl-search-icon" />
            <input
              className="sl-search"
              type="search"
              placeholder="Search sessions…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className="sl-list">
        {loading && (
          <div className="sl-empty">
            <div className="sl-spinner" />
          </div>
        )}

        {!loading && loadError && (
          <div className="sl-empty">
            <div className="sl-empty-icon">⚠️</div>
            <h2>Couldn't load sessions</h2>
            <p>Check that the server is running and try again.</p>
            <button className="sl-empty-cta" onClick={loadProjects}>Retry</button>
          </div>
        )}

        {!loading && !loadError && filtered.length === 0 && (
          <div className="sl-empty">
            <div className="sl-empty-icon">{query ? '🔍' : '💬'}</div>
            <h2>{query ? 'No results' : 'No sessions yet'}</h2>
            <p>{query ? `Nothing matched "${search}"` : 'Start your first chat below'}</p>
            {!query && (
              <button className="sl-empty-cta" onClick={onNewChat}>+ Start a new chat</button>
            )}
          </div>
        )}

        {/* Recent section — only when not searching */}
        {!query && !loading && recentSessions.length > 0 && (
          <div className="sl-recent-section">
            <div className="sl-section-label">Recent</div>
            {recentSessions.map(s => (
              <SessionCard
                key={s.sessionId}
                session={s}
                projectId={s.projectId}
                onOpen={handleOpenSession}
                onRename={setRenamingId}
                renamingId={renamingId}
                onRenameComplete={handleRenameComplete}
                isActive={activeSessionIds.has(s.sessionId)}
              />
            ))}
          </div>
        )}

        {/* All projects grouped */}
        {filtered.length > 0 && (
          <>
            {!query && <div className="sl-section-label sl-section-label-projects">Projects</div>}
            {filtered.map(proj => {
              const pathParts = (proj.originalPath || proj.id).split('/').filter(Boolean);
              const shortPath = pathParts.slice(-2).join('/');
              const projectName = pathParts[pathParts.length - 1] || shortPath;
              const isExpanded = displayExpanded.has(proj.id);

              return (
                <div key={proj.id} className={`sl-group ${isExpanded ? 'expanded' : ''}`}>
                  <div className="sl-group-header" onClick={() => toggleProject(proj.id)}>
                    <div className="sl-group-name-wrap">
                      <span className="sl-group-name">{projectName}</span>
                      <span className="sl-group-path">{shortPath}</span>
                    </div>
                    <span className="sl-group-meta">
                      <span className="sl-group-count">{proj.sessions.length}</span>
                      <ChevronDown size={14} className="sl-chevron" />
                    </span>
                  </div>

                  {isExpanded && (
                    <div className="sl-group-sessions">
                      {proj.sessions.map(s => (
                        <SessionCard
                          key={s.sessionId}
                          session={s}
                          projectId={proj.id}
                          onOpen={handleOpenSession}
                          onRename={setRenamingId}
                          renamingId={renamingId}
                          onRenameComplete={handleRenameComplete}
                          isActive={activeSessionIds.has(s.sessionId)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
