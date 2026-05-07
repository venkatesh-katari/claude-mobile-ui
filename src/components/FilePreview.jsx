import { useState, useEffect } from 'react';
import { marked } from 'marked';
import hljs from 'highlight.js';
import { X, Copy, Check, Eye, Code2 } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { copyToClipboard } from '../utils/clipboard';
import './FilePreview.css';

function getExt(path) {
  return path.split('.').pop()?.toLowerCase() || '';
}

function getLang(ext) {
  const map = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    kt: 'kotlin', sh: 'bash', bash: 'bash', zsh: 'bash',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    css: 'css', scss: 'scss', html: 'html', xml: 'xml',
    md: 'markdown', sql: 'sql', tf: 'hcl', hcl: 'hcl',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  };
  return map[ext] || 'plaintext';
}

export default function FilePreview({ path, onClose }) {
  const [state, setState] = useState('loading');
  const [content, setContent] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [copied, setCopied] = useState(false);

  const fileName = path.split('/').pop();
  const ext = getExt(path);
  const isMarkdown = ext === 'md' || ext === 'mdx';
  const isPlainText = ext === 'txt';

  // Default to rendered view for md/txt, raw code for everything else
  const [renderMode, setRenderMode] = useState(isMarkdown ? 'rendered' : 'raw');

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch(`/api/file-content?path=${encodeURIComponent(path)}`);
        if (res.status === 415) { setState('binary'); return; }
        if (!res.ok) { setState('error'); return; }
        const data = await res.json();
        setContent(data.content);
        setTruncated(data.truncated);
        setState('ok');
      } catch {
        setState('error');
      }
    }
    load();
  }, [path]);

  function handleCopy() {
    copyToClipboard(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const lang = getLang(ext);
  const highlighted = state === 'ok' && renderMode === 'raw'
    ? (hljs.getLanguage(lang)
        ? hljs.highlight(content, { language: lang }).value
        : content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    : '';

  const canToggle = isMarkdown || isPlainText;

  return (
    <div className="fp-overlay" onClick={onClose}>
      <div className="fp-sheet" onClick={e => e.stopPropagation()}>
        <div className="fp-handle-bar">
          <div className="fp-handle" />
        </div>
        <div className="fp-header">
          <span className="fp-filename">{fileName}</span>
          <div className="fp-actions">
            {state === 'ok' && canToggle && (
              <button
                className="fp-mode-btn"
                onClick={() => setRenderMode(m => m === 'rendered' ? 'raw' : 'rendered')}
                title="Toggle view"
              >
                {renderMode === 'rendered'
                  ? <><Code2 size={12} /><span>Raw</span></>
                  : <><Eye size={12} /><span>Preview</span></>
                }
              </button>
            )}
            {state === 'ok' && (
              <button className={`fp-copy ${copied ? 'copied' : ''}`} onClick={handleCopy}>
                {copied ? <><Check size={12} /><span>Copied</span></> : <><Copy size={12} /><span>Copy</span></>}
              </button>
            )}
            <button className="fp-close" onClick={onClose}><X size={16} /></button>
          </div>
        </div>

        <div className="fp-body">
          {state === 'loading' && <div className="fp-status">Loading…</div>}
          {state === 'error' && <div className="fp-status fp-error">Failed to load file</div>}
          {state === 'binary' && <div className="fp-status">Binary or unsupported file type</div>}
          {state === 'ok' && (
            <>
              {truncated && (
                <div className="fp-truncated">Showing first 50 KB of file</div>
              )}

              {renderMode === 'rendered' && isMarkdown && (
                <div
                  className="fp-markdown cv-msg-body"
                  dangerouslySetInnerHTML={{ __html: marked.parse(content) }}
                />
              )}

              {renderMode === 'rendered' && isPlainText && (
                <pre className="fp-plain">{content}</pre>
              )}

              {renderMode === 'raw' && (
                <pre className="fp-pre hljs">
                  <code dangerouslySetInnerHTML={{ __html: highlighted }} />
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
