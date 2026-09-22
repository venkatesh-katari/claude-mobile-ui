import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { createPatch } from 'diff';
import { marked } from 'marked';
import hljs from 'highlight.js';
import {
  ArrowLeft, FolderOpen, MoreHorizontal, Mic, MicOff, ArrowUp,
  FileText, FilePen, Terminal, Search, Globe, List, BookOpen,
  Wrench, Sun, Moon, Download, Check, ChevronDown, ChevronUp, ChevronRight, Copy,
  RotateCcw, WifiOff, Square, ArrowDown, Clock, Pencil, AtSign,
  X, History, Slash, Sparkles, Plus, GitCompare
} from 'lucide-react';
import { copyToClipboard } from '../utils/clipboard';
import { apiFetch } from '../utils/api';
import { renderMermaidDiagram } from '../utils/mermaid';
import { useWakeLock } from '../utils/useWakeLock';
import { appendTextDelta, completeTurn, finishStream, upsertToolEvent } from '../chat/events';
import Explorer from './Explorer';
import NewChatSetup from './NewChatSetup';
import GitDiffSheet from './GitDiffSheet';
import './ChatView.css';

// Configure marked
let codeBlockId = 0;
const renderer = new marked.Renderer();
renderer.code = function ({ text, lang }) {
  const id = `code-${++codeBlockId}`;
  const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
  if (language === 'mermaid') {
    return `<div class="cv-mermaid-wrap" data-mermaid-block>
      <div class="cv-mermaid-stage" role="img" aria-label="Mermaid diagram" aria-busy="true">
        <span class="cv-mermaid-loading">Rendering diagram…</span>
      </div>
      <details class="cv-mermaid-source">
        <summary>View Mermaid source</summary>
        <pre><code id="${id}">${escapeHtml(text)}</code></pre>
      </details>
    </div>`;
  }
  const langLabel = lang ? `<span class="cv-code-lang">${lang}</span>` : '';
  const highlighted =
    lang && hljs.getLanguage(lang)
      ? hljs.highlight(text, { language: lang }).value
      : escapeHtml(text);
  return `<div class="cv-code-wrap">
    ${langLabel}
    <button class="cv-code-copy" onclick="window.__copyCode('${id}', this)">Copy</button>
    <pre><code id="${id}" class="hljs">${highlighted}</code></pre>
  </div>`;
};
marked.setOptions({ renderer, breaks: true, gfm: true });

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

window.__copyCode = (id, btn) => {
  const el = document.getElementById(id);
  if (!el) return;
  copyToClipboard(el.textContent).then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
};

const ACTIVE_PROCESS_KEY = 'agent_mobile_active_process';

function readActiveProcess() {
  try {
    const value = JSON.parse(sessionStorage.getItem(ACTIVE_PROCESS_KEY) || 'null');
    if (!value || typeof value.id !== 'string' || typeof value.backend !== 'string') return null;
    return value;
  } catch {
    // Raw process IDs from older releases cannot be safely associated with a
    // backend. Discard them and use server-side session discovery instead.
    sessionStorage.removeItem(ACTIVE_PROCESS_KEY);
    return null;
  }
}

function saveActiveProcess(id, backend, sessionId = null) {
  sessionStorage.setItem(ACTIVE_PROCESS_KEY, JSON.stringify({ id, backend, sessionId }));
}

function clearActiveProcess(id = null) {
  const current = readActiveProcess();
  if (!id || !current || current.id === id) sessionStorage.removeItem(ACTIVE_PROCESS_KEY);
}

// ============================================================================
// Overflow menu (⋯)
// ============================================================================
function OverflowMenu({ theme, onToggleTheme, onExport, canExport, permissionMode, onPermissionChange, model, onModelChange, models, permissionModes }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="cv-overflow-btn" onClick={() => setOpen(true)} title="More options">
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div className="cv-menu-overlay" onClick={() => setOpen(false)}>
          <div className="cv-menu-sheet" onClick={e => e.stopPropagation()}>
            <div className="cv-menu-handle" />

            <div className="cv-menu-section-label">Model</div>
            {models.map(m => (
              <button
                key={m.value}
                className={`cv-menu-item ${model === m.value ? 'active' : ''}`}
                onClick={() => { onModelChange(m.value); setOpen(false); }}
              >
                <span className="cv-menu-item-label">{m.label}</span>
                <span className="cv-menu-item-desc">{m.description}</span>
                {model === m.value && <Check size={14} className="cv-menu-check" />}
              </button>
            ))}

            <div className="cv-menu-divider" />

            <div className="cv-menu-section-label">Permission Mode</div>
            {permissionModes.map(m => (
              <button
                key={m.value}
                className={`cv-menu-item ${permissionMode === m.value ? 'active' : ''}`}
                onClick={() => { onPermissionChange(m.value); setOpen(false); }}
              >
                <span className="cv-menu-item-label">{m.label}</span>
                <span className="cv-menu-item-desc">{m.description}</span>
                {permissionMode === m.value && <Check size={14} className="cv-menu-check" />}
              </button>
            ))}

            <div className="cv-menu-divider" />

            <button className="cv-menu-item" onClick={() => { onToggleTheme(); setOpen(false); }}>
              {theme === 'dark'
                ? <><Sun size={16} className="cv-menu-icon" /><span className="cv-menu-item-label">Light mode</span></>
                : <><Moon size={16} className="cv-menu-icon" /><span className="cv-menu-item-label">Dark mode</span></>
              }
            </button>
            <button
              className="cv-menu-item"
              onClick={() => { onExport(); setOpen(false); }}
              disabled={!canExport}
            >
              <Download size={16} className="cv-menu-icon" />
              <span className="cv-menu-item-label">Export conversation</span>
            </button>

            <button className="cv-menu-cancel" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

// ============================================================================
// Main ChatView
// ============================================================================
export default function ChatView({ chatState, onBack, onUpdateState, theme, onToggleTheme }) {
  const { backend = 'claude', sessionId, projectPath, title, permissionMode, model = 'claude-sonnet-5' } = chatState;
  const [backendDescriptors, setBackendDescriptors] = useState([]);
  const [messages, setMessages] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  useWakeLock(isStreaming);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [inputText, setInputText] = useState('');
  const [sendError, setSendError] = useState(null);
  const [showExplorer, setShowExplorer] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState(() => new Set());
  const [isNewChat, setIsNewChat] = useState(!sessionId);
  const [activeToolStatus, setActiveToolStatus] = useState(null); // "Writing server.js…"
  const [atBottom, setAtBottom] = useState(true);
  const [sessionCost, setSessionCost] = useState(0);
  const [sessionTokens, setSessionTokens] = useState(0);
  const [runtimeWarning, setRuntimeWarning] = useState(null);
  const [promptHistory, setPromptHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cv_prompt_history') || '[]'); } catch { return []; }
  });
  const [showHistory, setShowHistory] = useState(false);
  const [editingMsg, setEditingMsg] = useState(null); // { index, text }
  const [showAtPicker, setShowAtPicker] = useState(false);
  const [showSlashPicker, setShowSlashPicker] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showGitDiff, setShowGitDiff] = useState(false);
  const [gitIsRepo, setGitIsRepo] = useState(false);
  const [resumablePid, setResumablePid] = useState(null); // pid of a dropped-but-still-running stream
  const chatRef = useRef(null);
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const abortRef = useRef(null);
  const processIdRef = useRef(null);
  const streamCreatedSessionRef = useRef(null);

  const backendDescriptor = backendDescriptors.find(item => item.id === backend) || {
    id: backend,
    label: backend === 'codex' ? 'Codex CLI' : 'Claude Code',
    models: [],
    permissionModes: [],
    capabilities: {
      conflictDetection: backend === 'claude',
      dollarCost: backend === 'claude',
      interactiveQuestions: backend === 'claude',
      partialTextStreaming: backend === 'claude',
      skillsPicker: backend === 'claude',
      toolUse: true,
    },
  };

  useEffect(() => {
    apiFetch('/api/backends')
      .then(response => response.ok ? response.json() : Promise.reject())
      .then(setBackendDescriptors)
      .catch(() => {});
  }, []);

  const insertPath = useCallback((path) => {
    setInputText(prev => {
      const spacer = prev && !prev.endsWith(' ') ? ' ' : '';
      return prev + spacer + path + ' ';
    });
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (sessionId) {
      setIsNewChat(false);
      if (streamCreatedSessionRef.current === sessionId) return;
      loadMessages(sessionId);
    }
  }, [backend, sessionId]);

  // Reconnect to an in-progress workflow. Prefer the processId this tab
  // already remembers (cheap, no round trip); if that's gone — new device,
  // sessionStorage wiped by an iOS PWA relaunch, different tab — fall back
  // to asking the server whether *this* session has a stream still running,
  // so the workflow surviving a dropped connection is actually discoverable.
  useEffect(() => {
    if (processIdRef.current || isStreaming) return;
    const savedProcess = readActiveProcess();
    const savedProcessMatches = savedProcess
      && savedProcess.backend === backend
      && (!sessionId || !savedProcess.sessionId || savedProcess.sessionId === sessionId);
    if (savedProcessMatches) {
      reconnectToStream(savedProcess.id);
      return;
    }
    if (!sessionId) return;
    apiFetch('/api/streams/active-by-session')
      .then(r => r.ok ? r.json() : [])
      .then(active => {
        const match = active.find(a => a.backend === backend && a.sessionId === sessionId);
        if (match) reconnectToStream(match.processId);
      })
      .catch(() => {});
  }, [backend, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Gate the "+" sheet's Git Diff item on the project actually being a git
  // repo — cheap check, refreshed whenever the working directory changes.
  useEffect(() => {
    if (!projectPath) { setGitIsRepo(false); return; }
    apiFetch(`/api/git/status?cwd=${encodeURIComponent(projectPath)}`)
      .then(r => r.ok ? r.json() : { isRepo: false })
      .then(data => setGitIsRepo(!!data.isRepo))
      .catch(() => setGitIsRepo(false));
  }, [projectPath]);

  const sessionChangedFiles = useMemo(() => collectSessionChangedFiles(messages), [messages]);

  async function loadMessages(sid) {
    setLoadingMessages(true);
    setLoadError(false);
    try {
      const res = await apiFetch(`/api/sessions/${sid}/messages?backend=${encodeURIComponent(backend)}`);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const msgs = await res.json();
      setMessages(msgs);
    } catch (err) {
      console.error('Failed to load messages:', err);
      setLoadError(true);
    } finally {
      setLoadingMessages(false);
    }
  }

  async function reconnectToStream(pid) {
    try {
      const res = await apiFetch(`/api/stream/${pid}/replay`);
      if (!res.ok) { clearActiveProcess(pid); return; }
      setIsStreaming(true);
      processIdRef.current = pid;
      saveActiveProcess(pid, backend, sessionId);
      await consumeSSEStream(res);
    } catch {
      clearActiveProcess(pid);
    }
  }

  // Auto-scroll only when already at bottom
  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming, atBottom]);

  // Track whether user is at the bottom
  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    function onScroll() {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setAtBottom(distFromBottom < 80);
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Shrink container to visual viewport height so keyboard doesn't cover input
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    function onResize() {
      const container = containerRef.current;
      if (!container) return;
      container.style.height = (vv.height) + 'px';
      container.style.transform = vv.offsetTop > 0 ? `translateY(-${vv.offsetTop}px)` : '';
    }
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
    return () => {
      vv.removeEventListener('resize', onResize);
      vv.removeEventListener('scroll', onResize);
    };
  }, []);

  // Auto-reconnect when phone wakes up and a stream was in progress
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      const savedProcess = readActiveProcess();
      const savedProcessMatches = savedProcess
        && savedProcess.backend === backend
        && (!sessionId || !savedProcess.sessionId || savedProcess.sessionId === sessionId);
      const pid = savedProcessMatches ? savedProcess.id : resumablePid;
      if (!pid || isStreaming) return;
      setResumablePid(null);
      reconnectToStream(pid);
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [resumablePid, isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  async function consumeSSEStream(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamDone = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const obj = JSON.parse(line.slice(6));

            if (obj.type === 'process-id') {
              processIdRef.current = obj.id;
              saveActiveProcess(obj.id, backend, sessionId);
            } else if (obj.type === 'session-started') {
              if (obj.sessionId) {
                if (!sessionId) streamCreatedSessionRef.current = obj.sessionId;
                if (processIdRef.current) saveActiveProcess(processIdRef.current, backend, obj.sessionId);
                onUpdateState({ backend, sessionId: obj.sessionId });
              }
            } else if (obj.type === 'text-delta') {
              setMessages(previous => appendTextDelta(previous, obj.text));
            } else if (obj.type === 'tool-use') {
              const summary = getToolSummary(obj.name, obj.input);
              if (obj.status === 'completed' || obj.status === 'failed') setActiveToolStatus(null);
              else setActiveToolStatus(summary ? `${obj.name} · ${summary}` : obj.name);
              setMessages(previous => upsertToolEvent(previous, obj));
            } else if (obj.type === 'warning') {
              setRuntimeWarning(obj.message);
            } else if (obj.type === 'error') {
              setRuntimeWarning(`Agent error: ${obj.message}`);
            } else if (obj.type === 'turn-complete') {
              if (obj.sessionId) onUpdateState({ backend, sessionId: obj.sessionId });
              if (obj.cost?.usd) setSessionCost(previous => previous + obj.cost.usd);
              if (obj.cost?.tokens) {
                const usage = obj.cost.tokens;
                setSessionTokens(previous => previous + (usage.inputTokens || 0) + (usage.outputTokens || 0));
              }
              setMessages(previous => completeTurn(previous, obj));
              setActiveToolStatus(null);
            } else if (obj.type === 'stream-complete') {
              streamDone = true;
              setActiveToolStatus(null);
              setMessages(finishStream);
              notifyCompletion();
            }
          } catch { /* skip parse errors */ }
        }
      }
    } finally {
      // If the stream closed without a done event, the server process may still be running.
      // Save the pid so the user can resume instead of retrying.
      const processId = processIdRef.current;
      const wasAborted = abortRef.current?.signal.aborted === true;
      if (!streamDone && processId && !wasAborted) {
        setResumablePid(processId);
      } else {
        clearActiveProcess(processId);
      }
      setIsStreaming(false);
      setActiveToolStatus(null);
      processIdRef.current = null;
      abortRef.current = null;
    }
  }

  function notifyCompletion() {
    if (document.hidden) {
      document.title = `✓ ${backendDescriptor.label} replied — Agent Mobile`;
      const restore = () => { document.title = 'Agent Mobile'; document.removeEventListener('visibilitychange', restore); };
      document.addEventListener('visibilitychange', restore);
    }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.3);
    } catch {}
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      new Notification(`${backendDescriptor.label} replied`, { body: 'Your response is ready.', icon: '/icon-192.svg', tag: 'agent-reply' });
    }
  }

  const sendMessage = useCallback(async (overrideText) => {
    const text = (overrideText ?? inputText).trim();
    if (!text || isStreaming) return;

    setInputText('');
    setSendError(null);
    setResumablePid(null);
    setIsNewChat(false);
    setAtBottom(true);
    setRuntimeWarning(null);
    // Save to prompt history (deduplicated, max 20)
    if (!overrideText) {
      setPromptHistory(prev => {
        const next = [text, ...prev.filter(p => p !== text)].slice(0, 20);
        try { localStorage.setItem('cv_prompt_history', JSON.stringify(next)); } catch {}
        return next;
      });
    }
    // Haptic feedback on send
    try { navigator.vibrate?.(20); } catch {}
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last?.role === 'user' && last.content === text) return prev;
      return [...prev, { role: 'user', content: text }];
    });
    setIsStreaming(true);

    try {
      abortRef.current = new AbortController();
      const res = await apiFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend, message: text, sessionId, projectPath, permissionMode, model }),
        signal: abortRef.current.signal,
      });

      if (res.status === 429) {
        await res.json();
        setSendError({ text, reason: 'Agent capacity reached — try again shortly' });
        setIsStreaming(false);
        abortRef.current = null;
        return;
      }

      if (!res.ok) {
        let reason = `Server error (${res.status})`;
        try { const d = await res.json(); if (d.error) reason = d.error; } catch {}
        setSendError({ text, reason });
        setIsStreaming(false);
        abortRef.current = null;
        return;
      }

      await consumeSSEStream(res);
    } catch (err) {
      if (err.name === 'AbortError') {
        setIsStreaming(false);
        processIdRef.current = null;
        abortRef.current = null;
        clearActiveProcess();
        return;
      }
      // The POST may have actually reached the server and started a stream
      // even though this fetch() failed on our end (e.g. the phone's network
      // died mid-request) — reconnect to it instead of resending, which would
      // otherwise race a second backend resume process against the one
      // that's already running and writing to the same session file.
      if (sessionId) {
        try {
          const activeRes = await apiFetch('/api/streams/active-by-session');
          const active = activeRes.ok ? await activeRes.json() : [];
          const match = active.find(a => a.backend === backend && a.sessionId === sessionId);
          if (match) {
            abortRef.current = null;
            await reconnectToStream(match.processId);
            return;
          }
        } catch { /* fall through to the normal error/retry path below */ }
      }
      const isNetwork = err.message === 'Failed to fetch' || err.name === 'TypeError';
      setSendError({ text, reason: isNetwork ? 'Network error' : err.message });
      setIsStreaming(false);
      processIdRef.current = null;
      abortRef.current = null;
      if (!isNetwork) clearActiveProcess();
    }
  }, [backend, inputText, isStreaming, sessionId, projectPath, permissionMode, model, onUpdateState]);

  function handleStop() {
    if (processIdRef.current) {
      apiFetch(`/api/abort/${processIdRef.current}`, { method: 'POST' }).catch(() => {});
    }
    abortRef.current?.abort();
    clearActiveProcess(processIdRef.current);
    setIsStreaming(false);
    setActiveToolStatus(null);
    try { navigator.vibrate?.(40); } catch {}
  }

  // sendMessage's identity changes on every keystroke (it reads inputText), so we
  // stash the latest version in a ref and expose a referentially-stable wrapper —
  // otherwise MessageBubble's memoization below would be defeated on every keystroke.
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  const handleEditResend = useCallback((index, newText) => {
    setEditingMsg(null);
    const trimmed = newText.trim();
    if (!trimmed) return;
    // Slice messages up to (not including) the edited message, then resend
    setMessages(prev => prev.slice(0, index));
    sendMessageRef.current(trimmed);
  }, []);

  const handleEditStart = useCallback((idx, text) => setEditingMsg({ index: idx, text }), []);
  const handleEditCancel = useCallback(() => setEditingMsg(null), []);

  const handleAnswerQuestion = useCallback((replyText) => {
    sendMessageRef.current(replyText);
  }, []);

  function handleBack() {
    if (isStreaming && processIdRef.current) {
      apiFetch(`/api/abort/${processIdRef.current}`, { method: 'POST' }).catch(() => {});
      abortRef.current?.abort();
      clearActiveProcess(processIdRef.current);
    }
    onBack();
  }

  function handleExport() {
    const lines = [`# ${title}\n`];
    for (const msg of messages) {
      if (msg.role === 'user') lines.push(`## You\n\n${msg.content}\n`);
      else if (msg.role === 'assistant') {
        const text = (msg.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
        if (text) lines.push(`## ${backendDescriptor.label}\n\n${text}\n`);
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.slice(0, 40).replace(/[^a-z0-9]/gi, '-').toLowerCase()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const permissionLabel = backendDescriptor.permissionModes.find(item => item.value === permissionMode)?.label || permissionMode;
  const modelLabel = backendDescriptor.models.find(item => item.value === model)?.label || model;

  const QUICK_PROMPTS = [
    'Review this code', 'Write tests', 'Explain this', 'Fix the bug',
    'What changed?', 'Summarize', 'Refactor', 'Add error handling',
  ];

  return (
    <div className="cv-container" ref={containerRef}>
      {showExplorer && (
        <Explorer
          projectPath={projectPath}
          onClose={() => setShowExplorer(false)}
          onInsertPath={insertPath}
          expandedPaths={expandedPaths}
          onExpandedChange={setExpandedPaths}
        />
      )}

      {/* Prompt history bottom sheet */}
      {showHistory && (
        <div className="cv-menu-overlay" onClick={() => setShowHistory(false)}>
          <div className="cv-menu-sheet" onClick={e => e.stopPropagation()}>
            <div className="cv-menu-handle" />
            <div className="cv-menu-section-label">Recent prompts</div>
            {promptHistory.length === 0 && (
              <p className="cv-history-empty">No prompts yet</p>
            )}
            {promptHistory.map((p, i) => (
              <button key={i} className="cv-menu-item" onClick={() => {
                setInputText(p);
                setShowHistory(false);
                setTimeout(() => inputRef.current?.focus(), 50);
              }}>
                <History size={14} className="cv-menu-icon" />
                <span className="cv-menu-item-label cv-history-item">{p}</span>
              </button>
            ))}
            <button className="cv-menu-cancel" onClick={() => setShowHistory(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* @ file picker bottom sheet */}
      {showAtPicker && (
        <AtFilePicker
          projectPath={projectPath}
          onSelect={(path) => {
            setInputText(prev => {
              const atIdx = prev.lastIndexOf('@');
              return (atIdx >= 0 ? prev.slice(0, atIdx) : prev) + path + ' ';
            });
            setShowAtPicker(false);
            setTimeout(() => inputRef.current?.focus(), 50);
          }}
          onClose={() => setShowAtPicker(false)}
        />
      )}

      {/* / skill+command picker bottom sheet */}
      {showSlashPicker && backendDescriptor.capabilities.skillsPicker && (
        <SlashPicker
          backend={backend}
          projectPath={projectPath}
          onSelect={(invoke) => {
            setInputText(prev => {
              const idx = prev.lastIndexOf('/');
              return (idx >= 0 ? prev.slice(0, idx) : prev) + '/' + invoke + ' ';
            });
            setShowSlashPicker(false);
            setTimeout(() => inputRef.current?.focus(), 50);
          }}
          onClose={() => setShowSlashPicker(false)}
        />
      )}

      {/* Git diff bottom sheet */}
      {showGitDiff && (
        <GitDiffSheet
          projectPath={projectPath}
          sessionFiles={sessionChangedFiles}
          onClose={() => setShowGitDiff(false)}
        />
      )}

      <div className="cv-header">
        <button className="cv-back" onClick={handleBack}>
          <ArrowLeft size={18} />
          <span className="cv-back-label">Back</span>
        </button>
        <div className="cv-header-center">
          <span className="cv-title">{title}</span>
          <span className="cv-header-subtitle">
            {backendDescriptor.label}
            <span className="cv-header-dot">·</span>
            {modelLabel}
            <span className="cv-header-dot">·</span>
            {permissionLabel}
            {sessionCost > 0 && (
              <>
                <span className="cv-header-dot">·</span>
                ${sessionCost.toFixed(3)}
              </>
            )}
            {sessionTokens > 0 && (
              <>
                <span className="cv-header-dot">·</span>
                {sessionTokens.toLocaleString()} tokens
              </>
            )}
          </span>
        </div>
        <div className="cv-header-actions">
          <OverflowMenu
            theme={theme}
            onToggleTheme={onToggleTheme}
            onExport={handleExport}
            canExport={messages.length > 0}
            permissionMode={permissionMode}
            onPermissionChange={(mode) => onUpdateState({ permissionMode: mode })}
            model={model}
            onModelChange={(m) => onUpdateState({ model: m })}
            models={backendDescriptor.models}
            permissionModes={backendDescriptor.permissionModes}
          />
        </div>
      </div>

      <div className="cv-chat-wrap">
        <div className="cv-chat" ref={chatRef}>
          {isNewChat ? (
            <NewChatSetup
              backend={backend}
              backends={backendDescriptors}
              model={model}
              projectPath={projectPath}
              permissionMode={permissionMode}
              onUpdateState={onUpdateState}
            />
          ) : loadingMessages ? (
            <MessageSkeleton />
          ) : loadError ? (
            <div className="cv-load-error">
              <div className="cv-load-error-icon">⚠️</div>
              <h3 className="cv-load-error-title">Couldn't load this session</h3>
              <p className="cv-load-error-body">The session file may be missing or corrupted.</p>
              <div className="cv-load-error-actions">
                <button className="cv-load-error-retry" onClick={() => loadMessages(sessionId)}>
                  <RotateCcw size={14} />
                  Retry
                </button>
                <button className="cv-load-error-back" onClick={handleBack}>
                  <ArrowLeft size={14} />
                  Go Back
                </button>
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => (
                <MessageBubble
                  key={i}
                  msg={msg}
                  index={i}
                  isLastMessage={i === messages.length - 1}
                  isStreaming={isStreaming}
                  editingMsg={editingMsg}
                  onEditStart={handleEditStart}
                  onEditCancel={handleEditCancel}
                  onEditResend={handleEditResend}
                  onAnswerQuestion={handleAnswerQuestion}
                  allowInteractiveQuestions={backendDescriptor.capabilities.interactiveQuestions}
                  theme={theme}
                />
              ))}
              {resumablePid && !isStreaming && (
                <div className="cv-send-error cv-resume-banner">
                  <WifiOff size={13} className="cv-send-error-icon" />
                  <span className="cv-send-error-reason">Connection dropped</span>
                  <button className="cv-retry-btn" onClick={() => {
                    const pid = resumablePid;
                    setResumablePid(null);
                    reconnectToStream(pid);
                  }}>
                    <RotateCcw size={12} />
                    Resume
                  </button>
                </div>
              )}
              {sendError && !resumablePid && (
                <div className="cv-send-error">
                  <WifiOff size={13} className="cv-send-error-icon" />
                  <span className="cv-send-error-reason">{sendError.reason}</span>
                  <button className="cv-retry-btn" onClick={() => sendMessage(sendError.text)}>
                    <RotateCcw size={12} />
                    Retry
                  </button>
                </div>
              )}
              {runtimeWarning && (
                <div className="cv-runtime-warning" role="status">
                  <span>Policy notice</span>
                  <p>{runtimeWarning}</p>
                  <button onClick={() => setRuntimeWarning(null)} aria-label="Dismiss policy notice"><X size={13} /></button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Scroll-to-bottom FAB */}
        {!atBottom && (
          <button
            className={`cv-scroll-fab ${isStreaming ? 'streaming' : ''}`}
            onClick={() => {
              setAtBottom(true);
              chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
            }}
          >
            <ArrowDown size={16} />
            {isStreaming && <span className="cv-scroll-fab-label">Responding…</span>}
          </button>
        )}
      </div>

      {/* Actions bottom sheet — single "+" entry point for all input-bar controls */}
      {showActions && (
        <div className="cv-menu-overlay" onClick={() => setShowActions(false)}>
          <div className="cv-menu-sheet cv-action-sheet" onClick={e => e.stopPropagation()}>
            <div className="cv-menu-handle" />
            <div className="cv-action-sheet-title">Actions</div>
            <button className="cv-action-item" onClick={() => { setShowActions(false); setShowExplorer(true); }}>
              <span className="cv-action-icon-circle"><FolderOpen size={16} /></span>
              <span className="cv-action-label">Preview files from project</span>
              <ChevronRight size={16} className="cv-action-chevron" />
            </button>
            <button className="cv-action-item" onClick={() => {
              setShowActions(false);
              setInputText(prev => prev + '@');
              setShowAtPicker(true);
            }}>
              <span className="cv-action-icon-circle"><AtSign size={16} /></span>
              <span className="cv-action-label">Add files to chat</span>
              <ChevronRight size={16} className="cv-action-chevron" />
            </button>
            {backendDescriptor.capabilities.skillsPicker && (
              <button className="cv-action-item" onClick={() => {
                setShowActions(false);
                setInputText(prev => (prev ? prev : '') + '/');
                setShowSlashPicker(true);
              }}>
                <span className="cv-action-icon-circle"><Slash size={16} /></span>
                <span className="cv-action-label">Tool/command access</span>
                <ChevronRight size={16} className="cv-action-chevron" />
              </button>
            )}
            <button className="cv-action-item" onClick={() => { setShowActions(false); setShowHistory(true); }}>
              <span className="cv-action-icon-circle"><History size={16} /></span>
              <span className="cv-action-label">Recent prompts</span>
              <ChevronRight size={16} className="cv-action-chevron" />
            </button>
            <button className="cv-action-item" onClick={() => { setShowActions(false); setShowTemplates(true); }}>
              <span className="cv-action-icon-circle"><Sparkles size={16} /></span>
              <span className="cv-action-label">Prompt templates</span>
              <ChevronRight size={16} className="cv-action-chevron" />
            </button>
            {gitIsRepo && (
              <button className="cv-action-item" onClick={() => { setShowActions(false); setShowGitDiff(true); }}>
                <span className="cv-action-icon-circle"><GitCompare size={16} /></span>
                <span className="cv-action-label">Git diff</span>
                <ChevronRight size={16} className="cv-action-chevron" />
              </button>
            )}
            <button className="cv-menu-cancel" onClick={() => setShowActions(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Prompt templates bottom sheet */}
      {showTemplates && (
        <div className="cv-menu-overlay" onClick={() => setShowTemplates(false)}>
          <div className="cv-menu-sheet" onClick={e => e.stopPropagation()}>
            <div className="cv-menu-handle" />
            <div className="cv-menu-section-label">Prompt templates</div>
            {QUICK_PROMPTS.map(p => (
              <button key={p} className="cv-menu-item" onClick={() => {
                setInputText(p);
                setShowTemplates(false);
                setTimeout(() => inputRef.current?.focus(), 50);
              }}>
                <Sparkles size={14} className="cv-menu-icon" />
                <span className="cv-menu-item-label">{p}</span>
              </button>
            ))}
            <button className="cv-menu-cancel" onClick={() => setShowTemplates(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Active tool status + stop button */}
      {isStreaming && (
        <div className="cv-status-bar">
          <div className="cv-status-left">
            <span className="cv-dot" /><span className="cv-dot" /><span className="cv-dot" />
            {activeToolStatus && <span className="cv-status-tool">{activeToolStatus}</span>}
          </div>
          <button className="cv-stop-btn" onClick={handleStop}>
            <Square size={11} fill="currentColor" />
            Stop
          </button>
        </div>
      )}

      <div className="cv-input-bar">
        <button className="cv-input-action-btn" onClick={() => setShowActions(true)} title="Actions">
          <Plus size={18} />
        </button>
        <textarea
          ref={inputRef}
          className="cv-input"
          placeholder={`Message ${backendDescriptor.label}…`}
          rows={1}
          value={inputText}
          onChange={e => {
            const val = e.target.value;
            setInputText(val);
            if (sendError) setSendError(null);
            // Open @ picker when @ is typed
            if (val.endsWith('@')) setShowAtPicker(true);
            // Open / picker only when / is the very first character (slash-command position)
            if (val === '/' && backendDescriptor.capabilities.skillsPicker) setShowSlashPicker(true);
            else if (!val.startsWith('/')) setShowSlashPicker(false);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
          }}
        />
        <VoiceButton onTranscript={(t) => setInputText(prev => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + t)} />
        <button className="cv-send" disabled={!inputText.trim() || isStreaming} onClick={() => sendMessage()}>
          <ArrowUp size={18} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Loading skeleton
// ============================================================================
function MessageSkeleton() {
  return (
    <div className="cv-skeleton-wrap">
      {[80, 60, 95, 50, 70].map((w, i) => (
        <div key={i} className={`cv-skeleton-msg ${i % 2 === 0 ? 'cv-skeleton-assistant' : 'cv-skeleton-user'}`}>
          <div className="cv-skeleton-line" style={{ width: `${w}%` }} />
          {i % 2 === 0 && <div className="cv-skeleton-line" style={{ width: `${w - 20}%` }} />}
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Voice input button
// ============================================================================
function VoiceButton({ onTranscript }) {
  const [recording, setRecording] = useState(false);
  const recogRef = useRef(null);
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  function toggle() {
    if (recording) { recogRef.current?.stop(); setRecording(false); return; }
    const recog = new SpeechRecognition();
    recog.continuous = false;
    recog.interimResults = false;
    recog.lang = 'en-US';
    recog.onresult = (e) => onTranscript(Array.from(e.results).map(r => r[0].transcript).join(' '));
    recog.onend = () => setRecording(false);
    recog.onerror = () => setRecording(false);
    recog.start();
    recogRef.current = recog;
    setRecording(true);
  }

  return (
    <button className={`cv-voice-btn ${recording ? 'recording' : ''}`} onClick={toggle} title={recording ? 'Stop' : 'Voice input'} type="button">
      {recording ? <MicOff size={17} /> : <Mic size={17} />}
    </button>
  );
}

// ============================================================================
// Tool icons + summary
// ============================================================================
const TOOL_ICON_COMPONENTS = {
  Read: FileText, Write: FilePen, Edit: FilePen, Bash: Terminal,
  Glob: Search, Grep: Search, LS: List, WebFetch: Globe, WebSearch: Globe,
  TodoWrite: List, NotebookRead: BookOpen, NotebookEdit: BookOpen,
};

function getToolSummary(name, input) {
  if (!input) return '';
  if (['Read', 'Write', 'Edit'].includes(name)) {
    const fullPath = input.file_path || input.path || '';
    return fullPath.split('/').pop() || fullPath;
  }
  if (name === 'Bash') return (input.command || '').slice(0, 50);
  if (name === 'Glob') return input.pattern || '';
  if (name === 'Grep') return input.pattern || '';
  if (name === 'LS') {
    const p = input.path || '';
    return p.split('/').pop() || p;
  }
  if (['WebFetch', 'WebSearch'].includes(name)) return input.url || input.query || '';
  return '';
}

// ============================================================================
// Tool chip (compact, expandable)
// ============================================================================
function ToolChip({ part }) {
  const [expanded, setExpanded] = useState(false);
  const summary = getToolSummary(part.name, part.input);
  const hasInput = part.input && Object.keys(part.input).length > 0;
  const IconComponent = TOOL_ICON_COMPONENTS[part.name] || Wrench;

  return (
    <div className="cv-tool-chip-wrap">
      <div className="cv-tool-chip" onClick={() => hasInput && setExpanded(v => !v)}>
        <IconComponent size={12} className="cv-tool-chip-icon" />
        <span className="cv-tool-chip-name">{part.name}</span>
        {summary && <span className="cv-tool-chip-summary">{summary}</span>}
        {hasInput && (expanded
          ? <ChevronUp size={10} className="cv-tool-chip-chevron" />
          : <ChevronDown size={10} className="cv-tool-chip-chevron" />
        )}
      </div>
      {expanded && hasInput && (
        <pre className="cv-tool-chip-input">{JSON.stringify(part.input, null, 2)}</pre>
      )}
    </div>
  );
}

// ============================================================================
// Interactive question detection & rendering
//
// Claude Code's AskUserQuestion tool isn't offered to the model in headless
// (-p) mode (verified: absent from the CLI's own declared tool list for
// non-interactive sessions, with or without --input-format stream-json —
// there's no live tool_use block to intercept). When the model wants to ask
// a multiple-choice question anyway, it falls back to emitting the tool's
// input schema as plain assistant text instead. This detects that shape
// generically — any tool-specific renderer can be registered below — and
// falls back to a raw-JSON card for anything recognized-but-unspecialized.
// Answering just sends the chosen option(s) as the next chat message, since
// there's no live process to write a response back into.
// ============================================================================
function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function parseInteractiveQuestion(text) {
  if (!text) return null;
  const payload = tryParseJson(text.trim());
  if (!payload || payload.questions === undefined) return null;

  let questions = payload.questions;
  if (typeof questions === 'string') questions = tryParseJson(questions);
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const valid = questions.every(q => q && typeof q.question === 'string' && Array.isArray(q.options) && q.options.length > 0);
  if (!valid) return null;

  return { tool: 'AskUserQuestion', questions };
}

function QuestionOptions({ question, qi, selected, interactive, onToggle }) {
  return (
    <div className="cv-question-block">
      {question.header && <div className="cv-question-header">{question.header}</div>}
      <div className="cv-question-text">{question.question}</div>
      <div className="cv-question-options">
        {question.options.map(opt => (
          <button
            key={opt.label}
            type="button"
            disabled={!interactive}
            className={`cv-question-option ${selected.has(opt.label) ? 'selected' : ''}`}
            onClick={() => onToggle(qi, opt.label, question.multiSelect)}
          >
            <span className="cv-question-option-label">{opt.label}</span>
            {opt.description && <span className="cv-question-option-desc">{opt.description}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function AskUserQuestionCard({ questions, interactive, onAnswer }) {
  const [selections, setSelections] = useState(() => questions.map(() => new Set()));
  const [activeTab, setActiveTab] = useState(0);
  const tabbed = questions.length > 1;
  const isLastTab = activeTab === questions.length - 1;
  const allAnswered = questions.every((_, i) => selections[i].size > 0);

  function toggle(qIdx, label, multiSelect) {
    setSelections(prev => {
      const next = prev.map(s => new Set(s));
      if (multiSelect) {
        next[qIdx].has(label) ? next[qIdx].delete(label) : next[qIdx].add(label);
      } else {
        next[qIdx] = new Set([label]);
      }
      return next;
    });
    // Single-select answers advance the flow themselves; multiSelect needs an
    // explicit Next since "one tap" doesn't mean "done picking" for those.
    if (!multiSelect && tabbed && qIdx < questions.length - 1) {
      setActiveTab(qIdx + 1);
    }
  }

  function submit() {
    const reply = questions
      .map((q, i) => `${q.header ? q.header + ': ' : ''}${[...selections[i]].join(', ')}`)
      .join('\n');
    onAnswer(reply);
  }

  if (!interactive) {
    return (
      <div className="cv-question-card cv-question-answered">
        {questions.map((q, qi) => (
          <QuestionOptions key={qi} question={q} qi={qi} selected={selections[qi]} interactive={false} onToggle={() => {}} />
        ))}
      </div>
    );
  }

  if (!tabbed) {
    return (
      <div className="cv-question-card">
        <QuestionOptions question={questions[0]} qi={0} selected={selections[0]} interactive onToggle={toggle} />
        <button className="cv-question-submit" disabled={!allAnswered} onClick={submit}>
          Submit
        </button>
      </div>
    );
  }

  const active = questions[activeTab];
  return (
    <div className="cv-question-card cv-question-tabbed">
      <div className="cv-question-tabs" role="tablist">
        {questions.map((q, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === activeTab}
            className={`cv-question-tab ${i === activeTab ? 'active' : ''} ${selections[i].size > 0 ? 'answered' : ''}`}
            onClick={() => setActiveTab(i)}
          >
            {q.header || `Q${i + 1}`}
          </button>
        ))}
      </div>
      <QuestionOptions question={active} qi={activeTab} selected={selections[activeTab]} interactive onToggle={toggle} />
      <div className="cv-question-nav">
        {isLastTab ? (
          <button className="cv-question-submit" disabled={!allAnswered} onClick={submit}>
            Submit
          </button>
        ) : active.multiSelect ? (
          <button
            type="button"
            className="cv-question-next"
            disabled={selections[activeTab].size === 0}
            onClick={() => setActiveTab(activeTab + 1)}
          >
            Next
          </button>
        ) : null}
      </div>
    </div>
  );
}

const INTERACTIVE_QUESTION_RENDERERS = {
  AskUserQuestion: AskUserQuestionCard,
};
// Any other recognized-but-unspecialized question shape falls back to the same card —
// kept as a distinct name so a future tool can get bespoke rendering without touching this one.
const GenericQuestionCard = AskUserQuestionCard;

// ============================================================================
// Diff sheet — "N files changed" summary for Edit/Write tool calls
// ============================================================================
// Aggregates every Edit/Write tool_use across the whole loaded session
// (unlike buildDiffBlocks, which is scoped to one message) into a flat file
// list for the Git Diff sheet's "Edited this session" tab.
function collectSessionChangedFiles(messages) {
  const fileMap = new Map(); // path -> isNew
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.parts || []) {
      if (part.type !== 'tool_use') continue;
      if (part.name === 'Edit' && part.input?.file_path) {
        if (!fileMap.has(part.input.file_path)) fileMap.set(part.input.file_path, false);
      } else if (part.name === 'Write' && part.input?.file_path) {
        fileMap.set(part.input.file_path, true);
      }
    }
  }
  return Array.from(fileMap.entries()).map(([path, isNew]) => ({ path, status: isNew ? 'added' : 'modified' }));
}

function buildDiffBlocks(parts) {
  const fileMap = new Map(); // path → { oldLines, newLines }

  for (const part of parts) {
    if (part.type !== 'tool_use') continue;

    if (part.name === 'Edit' && part.input?.file_path) {
      const p = part.input.file_path;
      if (!fileMap.has(p)) fileMap.set(p, { old: '', new: '' });
      const entry = fileMap.get(p);
      // Chain edits: apply each old→new substitution to running content
      entry.old += part.input.old_string || '';
      entry.new += part.input.new_string || '';
    } else if (part.name === 'Write' && part.input?.file_path) {
      const p = part.input.file_path;
      fileMap.set(p, { old: '', new: part.input.content || '' });
    }
  }

  return Array.from(fileMap.entries()).map(([filePath, { old: oldStr, new: newStr }]) => {
    const fileName = filePath.split('/').pop();
    const patch = createPatch(fileName, oldStr, newStr, '', '', { context: 3 });
    return { filePath, fileName, patch, isNew: oldStr === '' };
  });
}

function DiffLine({ line }) {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff') || line.startsWith('index') || line.startsWith('\\')) return null;
  if (line.startsWith('@@')) return <div className="cv-diff-hunk">{line}</div>;
  if (line.startsWith('+')) return <div className="cv-diff-add">{line}</div>;
  if (line.startsWith('-')) return <div className="cv-diff-del">{line}</div>;
  return <div className="cv-diff-ctx">{line}</div>;
}

function DiffSheet({ parts, onClose }) {
  const blocks = buildDiffBlocks(parts);
  if (blocks.length === 0) return null;

  return (
    <div className="cv-menu-overlay" onClick={onClose}>
      <div className="cv-diff-sheet" onClick={e => e.stopPropagation()}>
        <div className="cv-menu-handle" />
        <div className="cv-diff-header">
          <span className="cv-diff-title">{blocks.length} file{blocks.length !== 1 ? 's' : ''} changed</span>
          <button className="cv-diff-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="cv-diff-body">
          {blocks.map(({ filePath, fileName, patch, isNew }) => (
            <div key={filePath} className="cv-diff-file">
              <div className="cv-diff-file-header">
                <span className="cv-diff-file-name">{fileName}</span>
                {isNew && <span className="cv-diff-new-badge">new</span>}
                <span className="cv-diff-file-path">{filePath}</span>
              </div>
              <div className="cv-diff-code">
                {patch.split('\n').map((line, i) => <DiffLine key={i} line={line} />)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// @ file picker bottom sheet
// ============================================================================
function AtFilePicker({ projectPath, onSelect, onClose }) {
  const [entries, setEntries] = useState([]);
  const [path, setPath] = useState(projectPath || null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    setLoading(true);
    setFetchError(false);
    apiFetch(`/api/files?dir=${encodeURIComponent(path || '')}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => { setEntries(data); setLoading(false); })
      .catch(() => { setFetchError(true); setLoading(false); });
  }, [path]);

  return (
    <div className="cv-menu-overlay" onClick={onClose}>
      <div className="cv-menu-sheet cv-at-sheet" onClick={e => e.stopPropagation()}>
        <div className="cv-menu-handle" />
        <div className="cv-at-header">
          <span className="cv-menu-section-label" style={{ padding: 0 }}>
            {path ? path.split('/').pop() : 'Files'}
          </span>
          {path && path !== projectPath && (
            <button className="cv-at-up" onClick={() => setPath(p => p.split('/').slice(0, -1).join('/') || projectPath)}>
              ↑ Up
            </button>
          )}
        </div>
        {loading && <p className="cv-history-empty">Loading…</p>}
        {!loading && fetchError && <p className="cv-history-empty">Couldn't load files — check server connection.</p>}
        {!loading && !fetchError && entries.length === 0 && <p className="cv-history-empty">Empty directory</p>}
        {!loading && !fetchError && entries.map(e => (
          <button key={e.path} className="cv-menu-item" onClick={() => {
            if (e.isDir) setPath(e.path);
            else onSelect(e.path);
          }}>
            <span className="cv-menu-icon" style={{ fontSize: 14 }}>{e.isDir ? '📁' : '📄'}</span>
            <span className="cv-menu-item-label">{e.name}</span>
            {!e.isDir && <span className="cv-menu-item-desc" style={{ fontSize: 11 }}>{e.name.split('.').pop()}</span>}
          </button>
        ))}
        <button className="cv-menu-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

// ============================================================================
// / skill+command picker bottom sheet
// ============================================================================
function SlashPicker({ backend, projectPath, onSelect, onClose }) {
  const [tab, setTab] = useState('skills');
  const [items, setItems] = useState({ skills: [], commands: [] });
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    apiFetch(`/api/slash-items?backend=${encodeURIComponent(backend)}&projectPath=${encodeURIComponent(projectPath || '')}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => { setItems(data); setLoading(false); })
      .catch(() => { setFetchError(true); setLoading(false); });
  }, [backend, projectPath]);

  const list = (items[tab] || []).filter(it =>
    !filter || it.invoke.toLowerCase().includes(filter.toLowerCase()) || it.description.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="cv-menu-overlay" onClick={onClose}>
      <div className="cv-menu-sheet cv-slash-sheet" onClick={e => e.stopPropagation()}>
        <div className="cv-menu-handle" />
        <div className="cv-slash-tabs">
          <button className={`cv-slash-tab ${tab === 'skills' ? 'active' : ''}`} onClick={() => setTab('skills')}>
            <Sparkles size={13} /> Skills
          </button>
          <button className={`cv-slash-tab ${tab === 'commands' ? 'active' : ''}`} onClick={() => setTab('commands')}>
            <Slash size={13} /> Commands
          </button>
        </div>
        <input
          className="cv-slash-filter"
          placeholder={`Filter ${tab}…`}
          value={filter}
          onChange={e => setFilter(e.target.value)}
          autoFocus
        />
        {loading && <p className="cv-history-empty">Loading…</p>}
        {!loading && fetchError && <p className="cv-history-empty">Couldn't load skills/commands — check server connection.</p>}
        {!loading && !fetchError && list.length === 0 && <p className="cv-history-empty">No {tab} found</p>}
        {!loading && !fetchError && list.map(it => (
          <button key={it.invoke} className="cv-menu-item" onClick={() => onSelect(it.invoke)}>
            <span className="cv-menu-item-label">/{it.invoke}</span>
            {it.description && <span className="cv-menu-item-desc cv-slash-desc">{it.description}</span>}
          </button>
        ))}
        <button className="cv-menu-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

// ============================================================================
// Message bubble
// ============================================================================
const MarkdownText = memo(function MarkdownText({ text, theme }) {
  const containerRef = useRef(null);
  const html = useMemo(() => marked.parse(text || ''), [text]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const blocks = [...container.querySelectorAll('[data-mermaid-block]')];
    if (blocks.length === 0) return undefined;

    let cancelled = false;
    const timeout = setTimeout(() => {
      for (const block of blocks) {
        const stage = block.querySelector('.cv-mermaid-stage');
        const sourceDetails = block.querySelector('.cv-mermaid-source');
        const definition = sourceDetails?.querySelector('code')?.textContent || '';
        if (!stage || !definition.trim()) continue;

        renderMermaidDiagram(definition, theme)
          .then(({ svg, bindFunctions }) => {
            if (cancelled || !stage.isConnected) return;
            stage.innerHTML = svg;
            stage.setAttribute('aria-busy', 'false');
            block.setAttribute('data-mermaid-state', 'rendered');
            bindFunctions?.(stage);
          })
          .catch(() => {
            if (cancelled || !stage.isConnected) return;
            stage.textContent = 'Could not render this Mermaid diagram.';
            stage.setAttribute('aria-busy', 'false');
            block.setAttribute('data-mermaid-state', 'error');
            if (sourceDetails) sourceDetails.open = true;
          });
      }
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [html, theme]);

  return <div ref={containerRef} dangerouslySetInnerHTML={{ __html: html }} />;
});

const MessageBubble = memo(function MessageBubble({ msg, index, isLastMessage, isStreaming, editingMsg, onEditStart, onEditCancel, onEditResend, onAnswerQuestion, allowInteractiveQuestions, theme }) {
  const [copied, setCopied] = useState(false);
  const [showCost, setShowCost] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const longPressTimer = useRef(null);
  const isEditingThis = editingMsg?.index === index;

  function handleCopy() {
    let text = msg.role === 'user' ? msg.content
      : (msg.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
    copyToClipboard(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  // Long press detection for mobile edit
  function onPressStart() {
    longPressTimer.current = setTimeout(() => {
      try { navigator.vibrate?.(30); } catch {}
      onEditStart(index, msg.content);
    }, 500);
  }
  function onPressEnd() { clearTimeout(longPressTimer.current); }

  if (msg.role === 'user') {
    if (isEditingThis) {
      return (
        <div className="cv-msg cv-user">
          <div className="cv-edit-wrap">
            <textarea
              className="cv-edit-input"
              defaultValue={editingMsg.text}
              autoFocus
              onKeyDown={e => {
                if (e.key === 'Escape') onEditCancel();
              }}
            />
            <div className="cv-edit-actions">
              <button className="cv-edit-cancel" onClick={onEditCancel}>Cancel</button>
              <button className="cv-edit-send" onClick={e => {
                const ta = e.target.closest('.cv-edit-wrap').querySelector('textarea');
                onEditResend(index, ta.value);
              }}>
                <ArrowUp size={14} strokeWidth={2.5} /> Resend
              </button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="cv-msg cv-user"
        onMouseDown={!isStreaming ? onPressStart : undefined}
        onMouseUp={onPressEnd}
        onTouchStart={!isStreaming ? onPressStart : undefined}
        onTouchEnd={onPressEnd}
      >
        <div className="cv-msg-body cv-user-body"><MarkdownText text={msg.content} theme={theme} /></div>
      </div>
    );
  }

  if (msg.role === 'assistant') {
    const parts = msg.parts || [];
    const hasText = parts.some(p => p.type === 'text');
    const tokenTotal = msg.tokens ? (msg.tokens.inputTokens || 0) + (msg.tokens.outputTokens || 0) : 0;
    const editParts = parts.filter(part => part.type === 'tool_use' && (
      (part.name === 'Edit' && (part.input?.old_string !== undefined || part.input?.new_string !== undefined))
      || (part.name === 'Write' && part.input?.content !== undefined)
    ));
    const changedFiles = new Set(editParts.map(p => p.input?.file_path).filter(Boolean));
    const showDiffChip = !msg._streaming && changedFiles.size > 0;
    return (
      <div className="cv-msg cv-assistant">
        {showDiff && <DiffSheet parts={parts} onClose={() => setShowDiff(false)} />}
        <div className="cv-assistant-dot" />
        <div className="cv-assistant-content">
          <div className="cv-msg-body cv-assistant-body">
            {parts.map((part, i) => {
              if (part.type !== 'text') return <ToolChip key={i} part={part} />;
              const question = allowInteractiveQuestions ? parseInteractiveQuestion(part.text) : null;
              if (question) {
                const Renderer = INTERACTIVE_QUESTION_RENDERERS[question.tool] || GenericQuestionCard;
                return (
                  <Renderer
                    key={i}
                    questions={question.questions}
                    interactive={isLastMessage && !isStreaming}
                    onAnswer={onAnswerQuestion}
                  />
                );
              }
              return <MarkdownText key={i} text={part.text} theme={theme} />;
            })}
          </div>
          <div className="cv-assistant-footer">
            {hasText && (
              <button className={`cv-msg-copy ${copied ? 'copied' : ''}`} onClick={handleCopy}>
                {copied ? <Check size={12} /> : <Copy size={12} />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            )}
            {showDiffChip && (
              <button className="cv-diff-chip" onClick={() => setShowDiff(true)}>
                <FilePen size={11} />
                {changedFiles.size} file{changedFiles.size !== 1 ? 's' : ''} changed
              </button>
            )}
            {(msg.cost || tokenTotal > 0) && (
              <button className="cv-cost-toggle" onClick={() => setShowCost(v => !v)}>
                <MoreHorizontal size={14} />
              </button>
            )}
            {(msg.cost || tokenTotal > 0) && showCost && (
              <span className="cv-cost">
                {msg.cost ? `$${msg.cost.toFixed(4)}` : `${tokenTotal.toLocaleString()} tokens`}
                {msg.duration ? ` · ${Math.round(msg.duration / 1000)}s` : ''}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (msg.role === 'tool_result') {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
    const truncated = content.length > 500 ? content.slice(0, 500) + '\n... (truncated)' : content;
    return (
      <div className="cv-msg cv-tool">
        <div className="cv-msg-label cv-tool-label">Tool Result{msg.isError ? ' (Error)' : ''}</div>
        <div className="cv-msg-body cv-tool-body">{truncated}</div>
      </div>
    );
  }

  return null;
});
