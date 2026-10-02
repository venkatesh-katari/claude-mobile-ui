import { useState, useCallback, useEffect } from 'react';
import SessionList from './components/SessionList';
import ChatView from './components/ChatView';
import LockScreen from './components/LockScreen';
import DiffViewerPage from './components/DiffViewerPage';
import { clearPin, apiFetch } from './utils/api';
import { DEFAULT_EFFORT } from './utils/effort';

const BACKEND_DEFAULTS = {
  claude: { model: 'sonnet', permissionMode: 'plan', effort: DEFAULT_EFFORT },
  codex: { model: 'default', permissionMode: 'read-only', effort: DEFAULT_EFFORT },
};

function getInitialBackend() {
  try {
    const saved = localStorage.getItem('agent_backend');
    if (saved === 'claude' || saved === 'codex') return saved;
  } catch {}
  return 'claude';
}

function getURLPermissionMode() {
  return new URLSearchParams(window.location.search).get('mode');
}

function getURLModel() {
  return new URLSearchParams(window.location.search).get('model');
}

function getURLEffort() {
  return new URLSearchParams(window.location.search).get('effort');
}

function sessionURL({ backend, sessionId, permissionMode, model, effort }) {
  const params = new URLSearchParams({ backend, session: sessionId, mode: permissionMode, model, effort });
  return `/?${params}`;
}

function getInitialTheme() {
  try {
    const saved = localStorage.getItem('theme');
    if (saved) return saved;
  } catch {}
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export default function App() {
  // A standalone, chrome-free route for "open diff in new tab" — checked
  // before any hooks run so it never participates in App's own hook order.
  // There's no router in this app; this query param is the whole mechanism.
  if (new URLSearchParams(window.location.search).get('diffView') === '1') {
    return <DiffViewerPage />;
  }

  const [theme, setTheme] = useState(getInitialTheme);
  const [authState, setAuthState] = useState('checking'); // 'checking' | 'locked' | 'unlocked'

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch {}
  }, [theme]);

  // On mount, verify whether PIN is required and if we already have a valid one
  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await apiFetch('/api/auth/check');
        if (res.ok) {
          setAuthState('unlocked');
        } else if (res.status === 401 || res.status === 429) {
          // PIN required and stored PIN is wrong/missing
          clearPin();
          setAuthState('locked');
        } else {
          setAuthState('unlocked'); // unexpected — let them through
        }
      } catch {
        setAuthState('unlocked'); // server unreachable at startup — let app render
      }
    }
    checkAuth();
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const [view, setView] = useState('list');
  const [chatState, setChatState] = useState(() => {
    const backend = getInitialBackend();
    const defaults = BACKEND_DEFAULTS[backend];
    return {
      backend,
      sessionId: null,
      projectPath: null,
      projectId: null,
      title: 'New Chat',
      permissionMode: getURLPermissionMode() || defaults.permissionMode,
      model: getURLModel() || defaults.model,
      effort: getURLEffort() || defaults.effort,
    };
  });

  // A session id found in the URL on load (deep link / refresh) — SessionList
  // resolves it against the project/session data it fetches anyway, then reports
  // back via onDeepLinkResolved so we only try once.
  const [deepLinkSessionId, setDeepLinkSessionId] = useState(
    () => new URLSearchParams(window.location.search).get('session')
  );
  const [deepLinkBackend] = useState(
    () => new URLSearchParams(window.location.search).get('backend') || 'claude'
  );

  const openSession = useCallback((backend, sessionId, projectPath, projectId, title) => {
    const defaults = BACKEND_DEFAULTS[backend] || BACKEND_DEFAULTS.claude;
    const permissionMode = getURLPermissionMode() || defaults.permissionMode;
    const model = getURLModel() || defaults.model;
    const effort = getURLEffort() || defaults.effort;
    setChatState({
      backend,
      sessionId,
      projectPath,
      projectId,
      title,
      permissionMode,
      model,
      effort,
    });
    setView('chat');
    window.history.replaceState(null, '', sessionURL({ backend, sessionId, permissionMode, model, effort }));
  }, []);

  const startNewChat = useCallback(() => {
    setChatState(s => ({
      sessionId: null,
      projectPath: null,
      projectId: null,
      title: 'New Chat',
      backend: s.backend,
      permissionMode: s.permissionMode,
      model: s.model,
      effort: s.effort,
    }));
    setView('chat');
    window.history.replaceState(null, '', '/');
  }, []);

  const goBack = useCallback(() => {
    setView('list');
    window.history.replaceState(null, '', '/');
  }, []);

  const updateChatState = useCallback((updates) => {
    setChatState(s => ({ ...s, ...updates }));
    if (updates.backend) {
      try { localStorage.setItem('agent_backend', updates.backend); } catch {}
    }
    const sessionId = updates.sessionId || chatState.sessionId;
    if (sessionId) {
      const backend = updates.backend || chatState.backend;
      const permissionMode = updates.permissionMode || chatState.permissionMode;
      const model = updates.model || chatState.model;
      const effort = updates.effort || chatState.effort;
      window.history.replaceState(null, '', sessionURL({ backend, sessionId, permissionMode, model, effort }));
    }
  }, [chatState]);

  const handleDeepLinkResolved = useCallback((found) => {
    setDeepLinkSessionId(null);
    if (!found) window.history.replaceState(null, '', '/');
  }, []);

  if (authState === 'checking') {
    return null; // brief blank while we verify — avoids lock screen flash on reload
  }

  if (authState === 'locked') {
    return <LockScreen onUnlock={() => setAuthState('unlocked')} />;
  }

  if (view === 'list') {
    return (
      <SessionList
        onOpenSession={openSession}
        onNewChat={startNewChat}
        theme={theme}
        onToggleTheme={toggleTheme}
        autoOpenSessionId={deepLinkSessionId}
        autoOpenBackend={deepLinkBackend}
        onDeepLinkResolved={handleDeepLinkResolved}
      />
    );
  }

  return (
    <ChatView
      chatState={chatState}
      onBack={goBack}
      onUpdateState={updateChatState}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  );
}
