import { parseDiff, Diff, Hunk } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import './GitDiffView.css';

// Thin wrapper around react-diff-view so both the in-app diff sheet and the
// standalone new-tab viewer (DiffViewerPage) render identically from the
// same real `git diff` text.
export default function GitDiffView({ diffText }) {
  if (!diffText || !diffText.trim()) {
    return <p className="gdv-empty">No changes.</p>;
  }

  let files = [];
  try {
    files = parseDiff(diffText);
  } catch {
    return <p className="gdv-empty">Couldn't parse this diff.</p>;
  }

  if (files.length === 0) {
    return <p className="gdv-empty">No changes.</p>;
  }

  return (
    <div className="gdv-root">
      {files.map(({ oldRevision, newRevision, type, hunks }) => (
        <Diff key={`${oldRevision}-${newRevision}`} viewType="unified" diffType={type} hunks={hunks}>
          {hunks => hunks.map(hunk => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      ))}
    </div>
  );
}
