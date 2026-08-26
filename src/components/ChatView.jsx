import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { createPatch } from 'diff';
import { marked } from 'marked';
import hljs from 'highlight.js';
import {
  ArrowLeft, FolderOpen, MoreHorizontal, Mic, MicOff, ArrowUp,
  FileText, FilePen, Terminal, Search, Globe, List, BookOpen,
  Wrench, Sun, Moon, Download, Check, ChevronDown, ChevronUp, ChevronRight, Copy,
  RotateCcw, WifiOff, Square, ArrowDown, Clock, Pencil, AtSign,
  DollarSign, X, History, Slash, Sparkles, Plus
} from 'lucide-react';
import { copyToClipboard } from '../utils/clipboard';
import { apiFetch } from '../utils/api';
import { useWakeLock } from '../utils/useWakeLock';
import Explorer from './Explorer';
import NewChatSetup from './NewChatSetup';
import './ChatView.css';

// Configure marked
let codeBlockId = 0;
const renderer = new marked.Renderer();
renderer.code = function ({ text, lang }) {
  const id = `code-${++codeBlockId}`;
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

const ACTIVE_PROCESS_KEY = 'claude_mobile_active_process';

// ============================================================================
// Overflow menu (⋯)
// ============================================================================
const MODELS = [
  { value: 'claude-sonnet-5', label: 'Sonnet', desc: 'Best balance of speed & quality' },
  { value: 'claude-opus-4-8', label: 'Opus', desc: 'Most capable, slower' },
  { value: 'haiku',  label: 'Haiku',  desc: 'Fastest, lightest tasks' },
];

const MODES = [
  { value: 'plan',               label: 'Plan',         desc: 'Read-only, no changes' },
  { value: 'acceptEdits',        label: 'Accept Edits', desc: 'Auto-approve file edits' },
  { value: 'auto',               label: 'Auto',         desc: 'Approve everything' },
  { value: 'default',            label: 'Default',      desc: 'Deny tools needing permission' },
  { value: 'bypassPermissions',  label: 'Bypass',       desc: 'Skip all permission checks' },
];

function OverflowMenu({ theme, onToggleTheme, onExport, canExport, permissionMode, onPermissionChange, model, onModelChange }) {
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
            {MODELS.map(m => (
              <button
                key={m.value}
                className={`cv-menu-item ${model === m.value ? 'active' : ''}`}
                onClick={() => { onModelChange(m.value); setOpen(false); }}
              >
                <span className="cv-menu-item-label">{m.label}</span>
                <span className="cv-menu-item-desc">{m.desc}</span>
                {model === m.value && <Check size={14} className="cv-menu-check" />}
              </button>
            ))}

            <div className="cv-menu-divider" />

            <div className="cv-menu-section-label">Permission Mode</div>
            {MODES.map(m => (
              <button
                key={m.value}
                className={`cv-menu-item ${permissionMode === m.value ? 'active' : ''}`}
                onClick={() => { onPermissionChange(m.value); setOpen(false); }}
              >
                <span className="cv-menu-item-label">{m.label}</span>
                <span className="cv-menu-item-desc">{m.desc}</span>
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
  const { sessionId, projectPath, title, permissionMode, model = 'claude-sonnet-5' } = chatState;
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
  const [promptHistory, setPromptHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cv_prompt_history') || '[]'); } catch { return []; }
  });
  const [showHistory, setShowHistory] = useState(false);
  const [editingMsg, setEditingMsg] = useState(null); // { index, text }
  const [showAtPicker, setShowAtPicker] = useState(false);
  const [showSlashPicker, setShowSlashPicker] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [resumablePid, setResumablePid] = useState(null); // pid of a dropped-but-still-running stream
  const chatRef = useRef(null);
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const abortRef = useRef(null);
  const processIdRef = useRef(null);
  const assistantTextRef = useRef('');

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
      loadMessages(sessionId);
    }
  }, [sessionId]);

  useEffect(() => {
    const savedProcessId = sessionStorage.getItem(ACTIVE_PROCESS_KEY);
    if (savedProcessId) reconnectToStream(savedProcessId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadMessages(sid) {
    setLoadingMessages(true);
    setLoadError(false);
    try {
      const res = await apiFetch(`/api/sessions/${sid}/messages`);
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
      if (!res.ok) { sessionStorage.removeItem(ACTIVE_PROCESS_KEY); return; }
      setIsStreaming(true);
      processIdRef.current = pid;
      await consumeSSEStream(res);
    } catch {
      sessionStorage.removeItem(ACTIVE_PROCESS_KEY);
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
      const pid = sessionStorage.getItem(ACTIVE_PROCESS_KEY) || resumablePid;
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
              sessionStorage.setItem(ACTIVE_PROCESS_KEY, obj.id);
            } else if (obj.type === 'assistant') {
              const content = obj.message?.content || [];
              for (const block of content) {
                if (block.type === 'text') {
                  assistantTextRef.current += block.text;
                  const text = assistantTextRef.current;
                  setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant' && last._streaming) {
                      updated[updated.length - 1] = { ...last, parts: [{ type: 'text', text }] };
                    } else {
                      updated.push({ role: 'assistant', parts: [{ type: 'text', text }], _streaming: true });
                    }
                    return updated;
                  });
                } else if (block.type === 'tool_use') {
                  // Update active tool status line
                  const summary = getToolSummary(block.name, block.input);
                  setActiveToolStatus(summary ? `${block.name} · ${summary}` : block.name);
                  setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    const toolPart = { type: 'tool_use', name: block.name, input: block.input, id: block.id };
                    if (last?.role === 'assistant' && last._streaming) {
                      const parts = [...last.parts];
                      const ei = parts.findIndex(p => p.type === 'tool_use' && p.id === block.id);
                      if (ei >= 0) parts[ei] = toolPart; else parts.push(toolPart);
                      updated[updated.length - 1] = { ...last, parts };
                    } else {
                      updated.push({ role: 'assistant', parts: [toolPart], _streaming: true });
                    }
                    return updated;
                  });
                }
              }
            } else if (obj.type === 'result') {
              if (obj.session_id) onUpdateState({ sessionId: obj.session_id });
              if (obj.total_cost_usd) {
                setSessionCost(prev => prev + obj.total_cost_usd);
                setMessages(prev => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant') {
                    updated[updated.length - 1] = { ...last, _streaming: false, cost: obj.total_cost_usd, duration: obj.duration_ms };
                  }
                  return updated;
                });
              }
              setActiveToolStatus(null);
            } else if (obj.type === 'done') {
              streamDone = true;
              setActiveToolStatus(null);
              setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') updated[updated.length - 1] = { ...last, _streaming: false };
                return updated;
              });
              notifyCompletion();
            }
          } catch { /* skip parse errors */ }
        }
      }
    } finally {
      // If the stream closed without a done event, the server process may still be running.
      // Save the pid so the user can resume instead of retrying.
      if (!streamDone && processIdRef.current && abortRef.current && !abortRef.current.signal.aborted) {
        setResumablePid(processIdRef.current);
      }
      setIsStreaming(false);
      setActiveToolStatus(null);
      assistantTextRef.current = '';
      processIdRef.current = null;
      abortRef.current = null;
      sessionStorage.removeItem(ACTIVE_PROCESS_KEY);
    }
  }

  function notifyCompletion() {
    if (document.hidden) {
      document.title = '✓ Claude replied — Claude Mobile';
      const restore = () => { document.title = 'Claude Mobile'; document.removeEventListener('visibilitychange', restore); };
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
      new Notification('Claude replied', { body: 'Your response is ready.', icon: '/icon-192.svg', tag: 'claude-reply' });
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
    assistantTextRef.current = '';
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
        body: JSON.stringify({ message: text, sessionId, projectPath, permissionMode, model }),
        signal: abortRef.current.signal,
      });

      if (res.status === 429) {
        await res.json();
        setSendError({ text, reason: 'Claude is busy — try again shortly' });
        setIsStreaming(false);
        return;
      }

      if (!res.ok) {
        let reason = `Server error (${res.status})`;
        try { const d = await res.json(); if (d.error) reason = d.error; } catch {}
        setSendError({ text, reason });
        setIsStreaming(false);
        return;
      }

      await consumeSSEStream(res);
    } catch (err) {
      if (err.name !== 'AbortError') {
        const isNetwork = err.message === 'Failed to fetch' || err.name === 'TypeError';
        setSendError({ text, reason: isNetwork ? 'Network error' : err.message });
      }
      setIsStreaming(false);
      assistantTextRef.current = '';
      processIdRef.current = null;
      abortRef.current = null;
      sessionStorage.removeItem(ACTIVE_PROCESS_KEY);
    }
  }, [inputText, isStreaming, sessionId, projectPath, permissionMode, model, onUpdateState]);

  function handleStop() {
    if (processIdRef.current) {
      apiFetch(`/api/abort/${processIdRef.current}`, { method: 'POST' }).catch(() => {});
    }
    abortRef.current?.abort();
    sessionStorage.removeItem(ACTIVE_PROCESS_KEY);
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

  function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  function handleBack() {
    if (isStreaming && processIdRef.current) {
      apiFetch(`/api/abort/${processIdRef.current}`, { method: 'POST' }).catch(() => {});
      abortRef.current?.abort();
      sessionStorage.removeItem(ACTIVE_PROCESS_KEY);
    }
    onBack();
  }

  function handleExport() {
    const lines = [`# ${title}\n`];
    for (const msg of messages) {
      if (msg.role === 'user') lines.push(`## You\n\n${msg.content}\n`);
      else if (msg.role === 'assistant') {
        const text = (msg.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
        if (text) lines.push(`## Claude\n\n${text}\n`);
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

  const modeBadgeLabel = { plan: 'Plan', acceptEdits: 'Edits', auto: 'Auto', default: 'Default', bypassPermissions: 'Bypass' };
  const modelBadgeLabel = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' };

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
      {showSlashPicker && (
        <SlashPicker
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

      <div className="cv-header">
        <button className="cv-back" onClick={handleBack}>
          <ArrowLeft size={18} />
          <span className="cv-back-label">Back</span>
        </button>
        <div className="cv-header-center">
          <span className="cv-title">{title}</span>
          <span className="cv-header-subtitle">
            {modelBadgeLabel[model] || model}
            <span className="cv-header-dot">·</span>
            {modeBadgeLabel[permissionMode] || permissionMode}
            {sessionCost > 0 && (
              <>
                <span className="cv-header-dot">·</span>
                ${sessionCost.toFixed(3)}
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
          />
        </div>
      </div>

      <div className="cv-chat-wrap">
        <div className="cv-chat" ref={chatRef}>
          {isNewChat ? (
            <NewChatSetup projectPath={projectPath} permissionMode={permissionMode} onUpdateState={onUpdateState} />
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
                  isStreaming={isStreaming}
                  editingMsg={editingMsg}
                  onEditStart={handleEditStart}
                  onEditCancel={handleEditCancel}
                  onEditResend={handleEditResend}
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
            <button className="cv-action-item" onClick={() => {
              setShowActions(false);
              setInputText(prev => (prev ? prev : '') + '/');
              setShowSlashPicker(true);
            }}>
              <span className="cv-action-icon-circle"><Slash size={16} /></span>
              <span className="cv-action-label">Tool/command access</span>
              <ChevronRight size={16} className="cv-action-chevron" />
            </button>
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
          placeholder="Message Claude…"
          rows={1}
          value={inputText}
          onChange={e => {
            const val = e.target.value;
            setInputText(val);
            if (sendError) setSendError(null);
            // Open @ picker when @ is typed
            if (val.endsWith('@')) setShowAtPicker(true);
            // Open / picker only when / is the very first character (slash-command position)
            if (val === '/') setShowSlashPicker(true);
            else if (!val.startsWith('/')) setShowSlashPicker(false);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
          }}
          onKeyDown={handleKeydown}
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
// Diff sheet — "N files changed" summary for Edit/Write tool calls
// ============================================================================
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
function SlashPicker({ projectPath, onSelect, onClose }) {
  const [tab, setTab] = useState('skills');
  const [items, setItems] = useState({ skills: [], commands: [] });
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    apiFetch(`/api/slash-items?projectPath=${encodeURIComponent(projectPath || '')}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => { setItems(data); setLoading(false); })
      .catch(() => { setFetchError(true); setLoading(false); });
  }, [projectPath]);

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
const MarkdownText = memo(function MarkdownText({ text }) {
  const html = useMemo(() => marked.parse(text || ''), [text]);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
});

const MessageBubble = memo(function MessageBubble({ msg, index, isStreaming, editingMsg, onEditStart, onEditCancel, onEditResend }) {
  const [copied, setCopied] = useState(false);
  const [showCost, setShowCost] = useState(false);
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
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onEditResend(index, e.target.value); }
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
        <div className="cv-msg-body cv-user-body"><MarkdownText text={msg.content} /></div>
      </div>
    );
  }

  if (msg.role === 'assistant') {
    const parts = msg.parts || [];
    const hasText = parts.some(p => p.type === 'text');
    const editParts = parts.filter(p => p.type === 'tool_use' && (p.name === 'Edit' || p.name === 'Write'));
    const changedFiles = new Set(editParts.map(p => p.input?.file_path).filter(Boolean));
    const showDiffChip = !msg._streaming && changedFiles.size > 0;
    const [showDiff, setShowDiff] = useState(false);

    return (
      <div className="cv-msg cv-assistant">
        {showDiff && <DiffSheet parts={parts} onClose={() => setShowDiff(false)} />}
        <div className="cv-assistant-dot" />
        <div className="cv-assistant-content">
          <div className="cv-msg-body cv-assistant-body">
            {parts.map((part, i) =>
              part.type === 'text'
                ? <MarkdownText key={i} text={part.text} />
                : <ToolChip key={i} part={part} />
            )}
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
            {msg.cost && (
              <button className="cv-cost-toggle" onClick={() => setShowCost(v => !v)}>
                <MoreHorizontal size={14} />
              </button>
            )}
            {msg.cost && showCost && (
              <span className="cv-cost">${msg.cost.toFixed(4)} · {Math.round(msg.duration / 1000)}s</span>
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
