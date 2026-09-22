import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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

function sessionKey(backend, sessionId) {
  return `${backend}:${sessionId}`;
}

function RenameInput({ value, backend, sessionId, onDone }) {
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
        body: JSON.stringify({ backend, summary: trimmed }),
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

function SessionCard({ session, projectId, projectKey, onOpen, onRename, renamingId, onRenameComplete, isActive }) {
  const key = sessionKey(session.backend, session.sessionId);
  const isRenaming = renamingId === key;
  const displayTitle = session.summary && session.summary !== '(no title)'
    ? session.summary
    : null;

  return (
    <div
      className={`sl-session-card ${isActive ? 'sl-session-active' : ''}`}
      onClick={() => !isRenaming && onOpen(session.backend, session.sessionId, session.projectPath, projectId, session.summary)}
    >
      <div className="sl-session-title-row">
        {isRenaming ? (
          <RenameInput
            value={session.summary}
            backend={session.backend}
            sessionId={session.sessionId}
            onDone={(title) => onRenameComplete(projectKey, session.backend, session.sessionId, title)}
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
            <span className={`sl-backend-badge sl-backend-${session.backend}`}>
              {session.backend === 'codex' ? 'Codex' : 'Claude'}
            </span>
            <button
              className="sl-rename-btn"
              title="Rename"
              onClick={e => { e.stopPropagation(); onRename(key); }}
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

export default function SessionList({ onOpenSession, onNewChat, theme, onToggleTheme, autoOpenSessionId, autoOpenBackend, onDeepLinkResolved }) {
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
        .then(sessions => setActiveSessionIds(new Set(
          sessions.map(session => sessionKey(session.backend, session.sessionId))
        )))
        .catch(() => {});
    }
    fetchActive();
    const interval = setInterval(fetchActive, 5000);
    return () => clearInterval(interval);
  }, []);

  async function loadProjects() {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await apiFetch('/api/projects');
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const projs = await res.json();
      const sources = await Promise.all(projs.map(async proj => {
        try {
          const sessRes = await apiFetch(`/api/projects/${encodeURIComponent(proj.id)}/sessions?backend=${encodeURIComponent(proj.backend)}`);
          if (!sessRes.ok) return null;
          const sessions = await sessRes.json();
          return sessions.length ? {
            ...proj,
            sessions: sessions.map(session => ({ ...session, projectId: proj.id })),
          } : null;
        } catch {
          return null; // One corrupt project must not hide healthy projects.
        }
      }));

      // A filesystem project can contain sessions from both CLIs. Group by
      // exact cwd so users see one project with backend-tagged session cards.
      const grouped = new Map();
      for (const source of sources.filter(Boolean)) {
        const key = source.originalPath || `${source.backend}:${source.id}`;
        const group = grouped.get(key) || {
          id: key,
          key,
          originalPath: source.originalPath,
          sessionCount: 0,
          sessions: [],
        };
        group.sessionCount += source.sessionCount;
        group.sessions.push(...source.sessions);
        grouped.set(key, group);
      }
      const loaded = [...grouped.values()];
      for (const project of loaded) {
        project.sessions.sort((left, right) => new Date(right.modified || right.created) - new Date(left.modified || left.created));
      }
      setProjects(loaded);

      // Auto-expand the most recently modified project
      if (loaded.length > 0) {
        const mostRecent = loaded.reduce((best, p) => {
          const t = new Date(p.sessions[0]?.modified || 0);
          return t > new Date(best.sessions[0]?.modified || 0) ? p : best;
        });
        setExpanded(new Set([mostRecent.key]));
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

  // activeSessionIds only reflects streams this mobile server itself spawned,
  // so an entry here just means "reconnect to your own still-running stream,"
  // not a genuine conflict — ChatView's reconnect effect handles that via
  // /api/streams/active-by-session. A *real* desktop conflict (session last
  // touched by desktop CLI/VSCode/Cursor, and that origin still looks live)
  // is checked server-side; see SESSION_CONFLICT_DETECTION.md.
  const handleOpenSession = useCallback(async (backend, sessionId, projectPath, projectId, summary) => {
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}/conflict-check?backend=${encodeURIComponent(backend)}`);
      const { conflict } = res.ok ? await res.json() : { conflict: false };
      if (conflict) {
        setConflictSession({ backend, sessionId, projectPath, projectId, summary });
        return;
      }
    } catch { /* check failed — fall through and open normally */ }
    onOpenSession(backend, sessionId, projectPath, projectId, summary);
  }, [onOpenSession]);

  // Deep link / refresh landed on a specific session — once project data has
  // loaded, resolve it against the same list used for manual taps and open it.
  // Runs at most once per mount.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (!autoOpenSessionId || autoOpenedRef.current || loading) return;
    autoOpenedRef.current = true;
    const match = projects
      .flatMap(p => p.sessions)
      .find(s => s.sessionId === autoOpenSessionId && s.backend === autoOpenBackend);
    if (match) handleOpenSession(match.backend, match.sessionId, match.projectPath, match.projectId, match.summary);
    onDeepLinkResolved?.(!!match);
  }, [autoOpenSessionId, autoOpenBackend, loading, projects, handleOpenSession, onDeepLinkResolved]);

  const handleRenameComplete = useCallback((projectKey, backend, sessionId, newTitle) => {
    setProjects(prev => prev.map(p =>
      p.key !== projectKey ? p : {
        ...p,
        sessions: p.sessions.map(s => s.backend === backend && s.sessionId === sessionId ? { ...s, summary: newTitle } : s),
      }
    ));
    setRenamingId(null);
  }, []);

  const totalSessions = useMemo(() => projects.reduce((n, p) => n + p.sessions.length, 0), [projects]);
  const showSearch = totalSessions >= 10;

  // Flat recent sessions — latest 5 across all projects
  const recentSessions = useMemo(() => {
    const all = projects.flatMap(p => p.sessions.map(s => ({ ...s, projectKey: p.key })));
    return all.sort((a, b) => new Date(b.modified || b.created) - new Date(a.modified || a.created)).slice(0, 5);
  }, [projects]);

  const query = search.toLowerCase().trim();
  const filtered = query
    ? projects.map(p => ({ ...p, sessions: p.sessions.filter(s => s.summary.toLowerCase().includes(query)) })).filter(p => p.sessions.length > 0)
    : projects;
  const displayExpanded = query ? new Set(filtered.map(p => p.id)) : expanded;

  return (
    <div className="sl-container">

      {/* Conflict bottom sheet — real desktop-live signal, see SESSION_CONFLICT_DETECTION.md */}
      {conflictSession && (
        <div className="sl-conflict-overlay" onClick={() => setConflictSession(null)}>
          <div className="sl-conflict-sheet" onClick={e => e.stopPropagation()}>
            <div className="sl-conflict-handle" />
            <div className="sl-conflict-icon">⚠️</div>
            <h3 className="sl-conflict-title">May be open on desktop</h3>
            <p className="sl-conflict-body">
              <strong>{conflictSession.summary || 'This session'}</strong> looks like it has an active Claude Code window open on your desktop right now. Opening it here at the same time can corrupt the conversation history.
            </p>
            <button
              className="sl-conflict-btn sl-conflict-anyway"
              onClick={() => {
                onOpenSession(conflictSession.backend, conflictSession.sessionId, conflictSession.projectPath, conflictSession.projectId, conflictSession.summary);
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
        <h1>Agents</h1>
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
          ⏳ Agent capacity reached — {status.activeSessions}/{status.maxSessions} sessions active
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
                key={sessionKey(s.backend, s.sessionId)}
                session={s}
                projectId={s.projectId}
                projectKey={s.projectKey}
                onOpen={handleOpenSession}
                onRename={setRenamingId}
                renamingId={renamingId}
                onRenameComplete={handleRenameComplete}
                isActive={activeSessionIds.has(sessionKey(s.backend, s.sessionId))}
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
              const isExpanded = displayExpanded.has(proj.key);

              return (
                <div key={proj.key} className={`sl-group ${isExpanded ? 'expanded' : ''}`}>
                  <div className="sl-group-header" onClick={() => toggleProject(proj.key)}>
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
                          key={sessionKey(s.backend, s.sessionId)}
                          session={s}
                          projectId={s.projectId}
                          projectKey={proj.key}
                          onOpen={handleOpenSession}
                          onRename={setRenamingId}
                          renamingId={renamingId}
                          onRenameComplete={handleRenameComplete}
                          isActive={activeSessionIds.has(sessionKey(s.backend, s.sessionId))}
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
