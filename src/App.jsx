import { useState, useCallback, useEffect } from 'react';
import SessionList from './components/SessionList';
import ChatView from './components/ChatView';
import LockScreen from './components/LockScreen';
import { getPin, clearPin, apiFetch } from './utils/api';

function getInitialTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) return saved;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export default function App() {
  const [theme, setTheme] = useState(getInitialTheme);
  const [authState, setAuthState] = useState('checking'); // 'checking' | 'locked' | 'unlocked'

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
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
  const [chatState, setChatState] = useState({
    sessionId: null,
    projectPath: null,
    projectId: null,
    title: 'New Chat',
    permissionMode: 'plan',
  });

  const openSession = useCallback((sessionId, projectPath, projectId, title) => {
    setChatState(s => ({ ...s, sessionId, projectPath, projectId, title }));
    setView('chat');
  }, []);

  const startNewChat = useCallback(() => {
    setChatState({
      sessionId: null,
      projectPath: null,
      projectId: null,
      title: 'New Chat',
      permissionMode: 'plan',
    });
    setView('chat');
  }, []);

  const goBack = useCallback(() => setView('list'), []);

  const updateChatState = useCallback((updates) => {
    setChatState(s => ({ ...s, ...updates }));
  }, []);

  if (authState === 'checking') {
    return null; // brief blank while we verify — avoids lock screen flash on reload
  }

  if (authState === 'locked') {
    return <LockScreen onUnlock={() => setAuthState('unlocked')} />;
  }

  if (view === 'list') {
    return <SessionList onOpenSession={openSession} onNewChat={startNewChat} theme={theme} onToggleTheme={toggleTheme} />;
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
