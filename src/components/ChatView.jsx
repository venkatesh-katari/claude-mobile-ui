import { useState, useRef, useEffect, useCallback } from 'react';
import { marked } from 'marked';
import hljs from 'highlight.js';
import {
  ArrowLeft, FolderOpen, MoreHorizontal, Mic, MicOff, ArrowUp,
  FileText, FilePen, Terminal, Search, Globe, List, BookOpen,
  Wrench, Sun, Moon, Download, Check, ChevronDown, ChevronUp, Copy,
  RotateCcw, WifiOff, AlertCircle
} from 'lucide-react';
import { copyToClipboard } from '../utils/clipboard';
import { apiFetch } from '../utils/api';
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
function OverflowMenu({ theme, onToggleTheme, onExport, canExport, permissionMode, onPermissionChange }) {
  const [open, setOpen] = useState(false);

  const MODES = [
    { value: 'plan', label: 'Plan', desc: 'Read-only, no changes' },
    { value: 'acceptEdits', label: 'Accept Edits', desc: 'Auto-approve file edits' },
    { value: 'auto', label: 'Auto', desc: 'Approve everything' },
    { value: 'default', label: 'Default', desc: 'Deny tools needing permission' },
    { value: 'bypassPermissions', label: 'Bypass', desc: 'Skip all permission checks' },
  ];

  return (
    <>
      <button className="cv-overflow-btn" onClick={() => setOpen(true)} title="More options">
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div className="cv-menu-overlay" onClick={() => setOpen(false)}>
          <div className="cv-menu-sheet" onClick={e => e.stopPropagation()}>
            <div className="cv-menu-handle" />

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
  const { sessionId, projectPath, title, permissionMode } = chatState;
  const [messages, setMessages] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [inputText, setInputText] = useState('');
  const [sendError, setSendError] = useState(null); // { text, reason }
  const [showExplorer, setShowExplorer] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState(() => new Set());
  const [isNewChat, setIsNewChat] = useState(!sessionId);
  const chatRef = useRef(null);
  const inputRef = useRef(null);
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
    try {
      const res = await apiFetch(`/api/sessions/${sid}/messages`);
      const msgs = await res.json();
      setMessages(msgs);
    } catch (err) {
      console.error('Failed to load messages:', err);
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

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages, isStreaming]);

  async function consumeSSEStream(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
                setMessages(prev => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant') {
                    updated[updated.length - 1] = { ...last, _streaming: false, cost: obj.total_cost_usd, duration: obj.duration_ms };
                  }
                  return updated;
                });
              }
            } else if (obj.type === 'done') {
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
      setIsStreaming(false);
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
    setIsNewChat(false);
    assistantTextRef.current = '';
    setMessages(prev => {
      // Avoid duplicating the user message when retrying
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
        body: JSON.stringify({ message: text, sessionId, projectPath, permissionMode }),
        signal: abortRef.current.signal,
      });

      if (res.status === 429) {
        const data = await res.json();
        setSendError({ text, reason: 'Claude is busy — try again shortly' });
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
  }, [inputText, isStreaming, sessionId, projectPath, permissionMode, onUpdateState]);

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

  return (
    <div className="cv-container">
      {showExplorer && (
        <Explorer
          projectPath={projectPath}
          onClose={() => setShowExplorer(false)}
          onInsertPath={insertPath}
          expandedPaths={expandedPaths}
          onExpandedChange={setExpandedPaths}
        />
      )}

      <div className="cv-header">
        <button className="cv-back" onClick={handleBack}>
          <ArrowLeft size={18} />
          <span className="cv-back-label">Back</span>
        </button>
        <span className="cv-title">{title}</span>
        <div className="cv-header-actions">
          <button
            className={`cv-explorer-btn ${showExplorer ? 'active' : ''}`}
            onClick={() => setShowExplorer(v => !v)}
            title="Project Explorer"
          >
            <FolderOpen size={16} />
          </button>
          <span className="cv-mode-badge" title="Permission mode">
            {modeBadgeLabel[permissionMode] || permissionMode}
          </span>
          <OverflowMenu
            theme={theme}
            onToggleTheme={onToggleTheme}
            onExport={handleExport}
            canExport={messages.length > 0}
            permissionMode={permissionMode}
            onPermissionChange={(mode) => onUpdateState({ permissionMode: mode })}
          />
        </div>
      </div>

      <div className="cv-chat" ref={chatRef}>
        {isNewChat ? (
          <NewChatSetup projectPath={projectPath} permissionMode={permissionMode} onUpdateState={onUpdateState} />
        ) : loadingMessages ? (
          <MessageSkeleton />
        ) : (
          <>
            {messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)}
            {sendError && (
              <div className="cv-send-error">
                <WifiOff size={13} className="cv-send-error-icon" />
                <span className="cv-send-error-reason">{sendError.reason}</span>
                <button
                  className="cv-retry-btn"
                  onClick={() => sendMessage(sendError.text)}
                >
                  <RotateCcw size={12} />
                  Retry
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Thinking — dots only, no text */}
      {isStreaming && (
        <div className="cv-thinking">
          <span className="cv-dot" /><span className="cv-dot" /><span className="cv-dot" />
        </div>
      )}

      <div className="cv-input-bar">
        <textarea
          ref={inputRef}
          className="cv-input"
          placeholder="Message Claude..."
          rows={1}
          value={inputText}
          onChange={e => {
            setInputText(e.target.value);
            if (sendError) setSendError(null);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
          }}
          onKeyDown={handleKeydown}
        />
        <VoiceButton onTranscript={(t) => setInputText(prev => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + t)} />
        <button className="cv-send" disabled={!inputText.trim() || isStreaming} onClick={sendMessage}>
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
// Message bubble
// ============================================================================
function MessageBubble({ msg }) {
  const [copied, setCopied] = useState(false);
  const [showCost, setShowCost] = useState(false);

  function handleCopy() {
    let text = msg.role === 'user' ? msg.content
      : (msg.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
    copyToClipboard(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  if (msg.role === 'user') {
    return (
      <div className="cv-msg cv-user">
        <div className="cv-msg-body cv-user-body" dangerouslySetInnerHTML={{ __html: marked.parse(msg.content || '') }} />
      </div>
    );
  }

  if (msg.role === 'assistant') {
    const parts = msg.parts || [];
    const hasText = parts.some(p => p.type === 'text');

    return (
      <div className="cv-msg cv-assistant">
        <div className="cv-assistant-dot" />
        <div className="cv-assistant-content">
          <div className="cv-msg-body cv-assistant-body">
            {parts.map((part, i) =>
              part.type === 'text'
                ? <div key={i} dangerouslySetInnerHTML={{ __html: marked.parse(part.text || '') }} />
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
}
