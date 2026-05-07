import { useState, useCallback, useEffect } from 'react';
import {
  Folder, FolderOpen, File, FileText, FileCode, FileJson,
  Image, Settings, RefreshCw, Eye, EyeOff, X, Plus
} from 'lucide-react';
import { apiFetch } from '../utils/api';
import FilePreview from './FilePreview';
import './Explorer.css';

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function getFileIconComponent(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  const codeExts = new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'php', 'swift', 'kt', 'css', 'scss', 'html', 'xml', 'sh', 'bash', 'zsh']);
  const textExts = new Set(['md', 'txt', 'mdx']);
  const imgExts = new Set(['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp', 'ico']);
  const configExts = new Set(['json', 'yaml', 'yml', 'toml', 'env', 'lock', 'gitignore', 'dockerignore']);
  if (codeExts.has(ext)) return FileCode;
  if (textExts.has(ext)) return FileText;
  if (imgExts.has(ext)) return Image;
  if (configExts.has(ext)) return FileJson;
  return File;
}

export default function Explorer({ projectPath, onClose, onInsertPath, expandedPaths, onExpandedChange }) {
  const rootPath = projectPath || '/Users';
  const [showHidden, setShowHidden] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [previewPath, setPreviewPath] = useState(null);

  function handleRefresh() {
    setRefreshKey(k => k + 1);
  }

  return (
    <div className="exp-overlay" onClick={onClose}>
      {previewPath && (
        <FilePreview path={previewPath} onClose={() => setPreviewPath(null)} />
      )}
      <div className="exp-sidebar" onClick={e => e.stopPropagation()}>
        <div className="exp-header">
          <span className="exp-title">Explorer</span>
          <div className="exp-header-actions">
            <button
              className="exp-icon-btn"
              onClick={handleRefresh}
              title="Refresh"
            >
              <RefreshCw size={14} />
            </button>
            <button
              className={`exp-icon-btn ${showHidden ? 'active' : ''}`}
              onClick={() => setShowHidden(v => !v)}
              title={showHidden ? 'Hide hidden files' : 'Show hidden files'}
            >
              {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
            <button className="exp-icon-btn exp-close-btn" onClick={onClose} title="Close">
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="exp-tree">
          <FolderNode
            path={rootPath}
            name={rootPath.split('/').pop() || '/'}
            depth={0}
            defaultOpen
            showHidden={showHidden}
            onInsertPath={onInsertPath}
            onPreviewFile={setPreviewPath}
            expandedPaths={expandedPaths}
            onExpandedChange={onExpandedChange}
            refreshKey={refreshKey}
          />
        </div>
      </div>
    </div>
  );
}

function FolderNode({ path, name, depth, defaultOpen = false, showHidden, onInsertPath, onPreviewFile, expandedPaths, onExpandedChange, refreshKey }) {
  const isOpen = expandedPaths.has(path) || (defaultOpen && !expandedPaths.has(`__visited:${path}`));
  const [children, setChildren] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const setOpen = useCallback((open) => {
    onExpandedChange(prev => {
      const next = new Set(prev);
      next.add(`__visited:${path}`);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
  }, [path, onExpandedChange]);

  const fetchChildren = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const url = `/api/files?dir=${encodeURIComponent(path)}&hidden=${showHidden}${refresh ? '&refresh=true' : ''}`;
      const res = await apiFetch(url);
      const data = await res.json();
      setChildren(data);
    } catch {
      setChildren([]);
    } finally {
      setLoading(false);
    }
  }, [path, showHidden]);

  const toggle = useCallback(async () => {
    const willOpen = !isOpen;
    if (willOpen && children === null) {
      await fetchChildren();
    }
    setOpen(willOpen);
  }, [isOpen, children, fetchChildren, setOpen]);

  // Refetch when showHidden changes and folder is open
  useEffect(() => {
    if (isOpen && children !== null) fetchChildren();
  }, [showHidden]);

  // Refetch when refresh button is pressed and folder is open
  useEffect(() => {
    if (refreshKey > 0 && isOpen) fetchChildren(true);
  }, [refreshKey]);

  // Auto-load children for folders that were previously expanded (restored state)
  useEffect(() => {
    if (isOpen && children === null) fetchChildren();
  }, []);

  function addPath(e) {
    e.stopPropagation();
    onInsertPath?.(path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div>
      <div
        className="exp-row exp-folder"
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={toggle}
      >
        <span className="exp-icon">
          {isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
        </span>
        <span className="exp-name">{name}</span>
        <button
          className={`exp-copy ${copied ? 'copied' : ''}`}
          onClick={addPath}
          title="Add path to chat"
        >
          <Plus size={12} />
        </button>
      </div>

      {isOpen && loading && (
        <div className="exp-loading" style={{ paddingLeft: (depth + 1) * 16 + 8 }}>Loading...</div>
      )}

      {isOpen && children && children.map(entry => (
        entry.isDir ? (
          <FolderNode
            key={entry.path}
            path={entry.path}
            name={entry.name}
            depth={depth + 1}
            showHidden={showHidden}
            onInsertPath={onInsertPath}
            onPreviewFile={onPreviewFile}
            expandedPaths={expandedPaths}
            onExpandedChange={onExpandedChange}
            refreshKey={refreshKey}
          />
        ) : (
          <FileNode
            key={entry.path}
            entry={entry}
            depth={depth + 1}
            onInsertPath={onInsertPath}
            onPreviewFile={onPreviewFile}
          />
        )
      ))}
    </div>
  );
}

function FileNode({ entry, depth, onInsertPath, onPreviewFile }) {
  const [copied, setCopied] = useState(false);

  function addPath(e) {
    e.stopPropagation();
    onInsertPath?.(entry.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function handleClick() {
    onPreviewFile?.(entry.path);
  }

  const IconComponent = getFileIconComponent(entry.name);
  return (
    <div className="exp-row exp-file" style={{ paddingLeft: depth * 16 + 8 }} onClick={handleClick}>
      <span className="exp-icon">
        <IconComponent size={14} />
      </span>
      <span className="exp-name">{entry.name}</span>
      <button
        className={`exp-copy ${copied ? 'copied' : ''}`}
        onClick={addPath}
        title="Add path to chat"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}
