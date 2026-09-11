import { useState, useEffect } from 'react';
import { X, ArrowLeft, ExternalLink } from 'lucide-react';
import { apiFetch } from '../utils/api';
import GitDiffView from './GitDiffView';

const STATUS_LABEL = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflicted: '!' };

function displayPath(path, projectPath) {
  if (projectPath && path.startsWith(projectPath + '/')) return path.slice(projectPath.length + 1);
  return path;
}

// "+" sheet's Git Diff feature: two tabs (files edited this session / files
// changed since the last commit) both backed by the same real `git diff`
// endpoint, so the diff shown is always accurate — never a reconstruction
// from tool_use input like the per-message diff chip uses.
export default function GitDiffSheet({ projectPath, sessionFiles, onClose }) {
  const [tab, setTab] = useState('session');
  const [commitFiles, setCommitFiles] = useState([]);
  const [loadingCommit, setLoadingCommit] = useState(true);
  const [commitError, setCommitError] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [diffText, setDiffText] = useState('');
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState(false);

  useEffect(() => {
    apiFetch(`/api/git/status?cwd=${encodeURIComponent(projectPath || '')}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => { setCommitFiles(data.files || []); setLoadingCommit(false); })
      .catch(() => { setCommitError(true); setLoadingCommit(false); });
  }, [projectPath]);

  useEffect(() => {
    if (!selectedFile) return;
    setLoadingDiff(true);
    setDiffError(false);
    apiFetch(`/api/git/diff?cwd=${encodeURIComponent(projectPath || '')}&file=${encodeURIComponent(selectedFile)}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => { setDiffText(data.diff || ''); setLoadingDiff(false); })
      .catch(() => { setDiffError(true); setLoadingDiff(false); });
  }, [selectedFile, projectPath]);

  const list = tab === 'session' ? sessionFiles : commitFiles;

  function openInNewTab() {
    const url = `${window.location.origin}/?diffView=1&cwd=${encodeURIComponent(projectPath || '')}&file=${encodeURIComponent(selectedFile)}`;
    window.open(url, '_blank'); // no noopener — new tab inherits the PIN via sessionStorage
  }

  return (
    <div className="cv-menu-overlay" onClick={onClose}>
      <div className="cv-diff-sheet" onClick={e => e.stopPropagation()}>
        <div className="cv-menu-handle" />

        {selectedFile ? (
          <>
            <div className="cv-diff-header">
              <button className="gds-back-btn" onClick={() => setSelectedFile(null)}>
                <ArrowLeft size={15} /> Back
              </button>
              <span className="cv-diff-title gds-filename">{selectedFile.split('/').pop()}</span>
              <div className="gds-header-actions">
                <button className="cv-diff-close" onClick={openInNewTab} title="Open in new tab">
                  <ExternalLink size={16} />
                </button>
                <button className="cv-diff-close" onClick={onClose}><X size={16} /></button>
              </div>
            </div>
            <div className="cv-diff-body">
              {loadingDiff && <p className="cv-history-empty">Loading diff…</p>}
              {!loadingDiff && diffError && <p className="cv-history-empty">Couldn't load diff.</p>}
              {!loadingDiff && !diffError && <GitDiffView diffText={diffText} />}
            </div>
          </>
        ) : (
          <>
            <div className="cv-diff-header">
              <span className="cv-diff-title">Git Diff</span>
              <button className="cv-diff-close" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="cv-slash-tabs">
              <button className={`cv-slash-tab ${tab === 'session' ? 'active' : ''}`} onClick={() => setTab('session')}>
                Edited this session
              </button>
              <button className={`cv-slash-tab ${tab === 'commit' ? 'active' : ''}`} onClick={() => setTab('commit')}>
                Since last commit
              </button>
            </div>
            <div className="cv-diff-body">
              {tab === 'session' && sessionFiles.length === 0 && (
                <p className="cv-history-empty">No files edited yet this session.</p>
              )}
              {tab === 'commit' && loadingCommit && <p className="cv-history-empty">Loading…</p>}
              {tab === 'commit' && !loadingCommit && commitError && <p className="cv-history-empty">Couldn't load git status.</p>}
              {tab === 'commit' && !loadingCommit && !commitError && commitFiles.length === 0 && (
                <p className="cv-history-empty">Nothing changed since the last commit.</p>
              )}
              {list.map(f => (
                <button key={f.path} className="cv-menu-item" onClick={() => setSelectedFile(f.path)}>
                  <span className="gds-status-badge" data-status={f.status}>{STATUS_LABEL[f.status] || '?'}</span>
                  <span className="cv-menu-item-label gds-file-path">{displayPath(f.path, projectPath)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
