/**
 * Volt's build: a file tree by folder, a code viewer with line numbers, copy
 * and download per file, "Download all" as a .zip, and the install notes.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Build, BuildFile } from '../../agency/types';
import { Markdown } from './Markdown';
import { saveFile, zipFiles } from './zip';

function groupByFolder(files: BuildFile[]): [string, BuildFile[]][] {
  const groups = new Map<string, BuildFile[]>();
  for (const f of files) {
    const slash = f.path.lastIndexOf('/');
    const folder = slash === -1 ? '' : f.path.slice(0, slash);
    groups.set(folder, [...(groups.get(folder) ?? []), f]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function CodeViewer({ file }: { file: BuildFile }) {
  const lines = useMemo(() => file.content.replace(/\n$/, '').split('\n'), [file.content]);
  const gutter = useMemo(() => lines.map((_, i) => i + 1).join('\n'), [lines]);
  return (
    <div className="tv-code" role="region" aria-label={`${file.path}, ${lines.length} lines`} tabIndex={0}>
      <pre className="tv-code-gutter" aria-hidden="true">{gutter}</pre>
      <pre className="tv-code-text"><code>{lines.join('\n')}</code></pre>
    </div>
  );
}

export function FilesPanel({ build, taskNumber }: { build: Build; taskNumber: number }) {
  const groups = useMemo(() => groupByFolder(build.files), [build.files]);
  const [selected, setSelected] = useState(() => build.files[0]?.path ?? '');
  const [copied, setCopied] = useState(false);
  const file = build.files.find((f) => f.path === selected) ?? build.files[0];

  // A rework may rename files: keep the selection valid.
  useEffect(() => {
    if (!build.files.some((f) => f.path === selected)) setSelected(build.files[0]?.path ?? '');
  }, [build.files, selected]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
    } catch { /* clipboard blocked: the code is selectable */ }
  };

  return (
    <div className="tv-panel tv-files">
      <header className="tv-panel-head">
        <div>
          <h2>Files</h2>
          <p className="tv-panel-meta">Written by Volt · round {build.round} · {build.files.length} file{build.files.length === 1 ? '' : 's'}</p>
        </div>
        {build.files.length > 0 && (
          <button type="button" className="btn small" onClick={() => saveFile(`agentify-request-${taskNumber}-round-${build.round}.zip`, zipFiles(build.files))}>
            <span aria-hidden="true">⤓</span> Download all
          </button>
        )}
      </header>
      {build.summary && <Markdown text={build.summary} className="tv-lead" />}

      {file ? (
        <div className="tv-files-body">
          <nav className="tv-tree" aria-label="Files">
            {groups.map(([folder, files]) => (
              <div key={folder} className="tv-tree-group">
                {folder && <p className="tv-tree-folder"><span aria-hidden="true">▾</span> {folder}/</p>}
                <ul>
                  {files.map((f) => (
                    <li key={f.path}>
                      <button
                        type="button"
                        className="tv-tree-file"
                        aria-current={f.path === file.path ? 'true' : undefined}
                        onClick={() => setSelected(f.path)}
                        title={f.path}
                      >
                        {baseName(f.path)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <div className="tv-viewer">
            <div className="tv-viewer-bar">
              <span className="mono tv-viewer-path">{file.path}</span>
              <span className="tv-viewer-actions">
                <button type="button" className="btn small ghost" onClick={copy} aria-live="polite">
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
                <button type="button" className="btn small ghost" onClick={() => saveFile(baseName(file.path), file.content)}>Download</button>
              </span>
            </div>
            <CodeViewer key={file.path} file={file} />
          </div>
        </div>
      ) : (
        <p className="hint">This build has no files.</p>
      )}

      {build.installNotes && (
        <section className="tv-sec">
          <h3 className="tv-sec-title">Install notes</h3>
          <Markdown text={build.installNotes} />
        </section>
      )}
    </div>
  );
}
