/**
 * The message box under the thread. Enter sends, Shift+Enter breaks a line.
 * Files attach by the button, by pasting (screenshots) or by dropping them on
 * the box; images are downscaled before upload and show as thumbnails, other
 * files as chips, each with its own progress and error. A message may be
 * attachments only. The draft (text and uploaded files) survives closing the
 * request (sessionStorage, per task).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { Attachment } from '../../agency/types';
import { api } from '../api';
import { ACCEPT, MAX_FILES, formatSize, isImageFile, prepareImage, rejectReason, uploadWithProgress } from './attach';
import { session } from './useTaskRunner';

interface ComposerProps {
  taskId: string;
  hint: string;
  placeholder: string;
  onSend: (text: string, attachments: Attachment[]) => Promise<string | null>;
}

interface Pending {
  key: string;
  name: string;
  image: boolean;
  /** Object URL (local file) or the served attachment. */
  preview?: string;
  state: 'preparing' | 'uploading' | 'done' | 'error';
  progress: number;
  error?: string;
  attachment?: Attachment;
  /** Kept for a retry after a failed upload. */
  file?: File;
}

const MAX_HEIGHT = 200;
let seq = 0;

const restore = (key: string): Pending[] => {
  try {
    const saved = JSON.parse(session.get(key) ?? '[]') as Attachment[];
    return saved.map((a) => ({
      key: `r${++seq}`, name: a.name, image: a.type.startsWith('image/'), preview: a.type.startsWith('image/') ? api.attachmentUrl(a.id) : undefined,
      state: 'done', progress: 1, attachment: a,
    }));
  } catch {
    return [];
  }
};

function FileItem({ item, onRemove, onRetry }: { item: Pending; onRemove: () => void; onRetry: () => void }) {
  const busy = item.state === 'preparing' || item.state === 'uploading';
  const status = item.state === 'preparing' ? 'Preparing' : item.state === 'uploading' ? `Uploading ${Math.round(item.progress * 100)}%` : item.state === 'error' ? 'Failed' : 'Ready';
  return (
    <li className="tv-att-item" data-state={item.state} data-image={item.image || undefined}>
      {item.image && item.preview ? (
        <img className="tv-att-thumb" src={item.preview} alt="" />
      ) : (
        <span className="tv-att-icon" aria-hidden="true">{item.name.split('.').pop()?.slice(0, 4).toUpperCase() || 'FILE'}</span>
      )}
      <span className="tv-att-meta">
        <span className="tv-att-name" title={item.name}>{item.name}</span>
        <span className="tv-att-status" role={item.state === 'error' ? 'alert' : undefined}>
          {item.state === 'done' && item.attachment ? formatSize(item.attachment.size) : status}
          {item.state === 'error' && item.error ? ` — ${item.error}` : ''}
        </span>
      </span>
      {busy && (
        <span className="tv-att-progress" role="progressbar" aria-label={`Uploading ${item.name}`}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}>
          <span style={{ transform: `scaleX(${item.state === 'preparing' ? 0.05 : Math.max(0.05, item.progress)})` }} />
        </span>
      )}
      {item.state === 'error' && item.file && (
        <button type="button" className="btn small ghost tv-att-btn" onClick={onRetry} aria-label={`Retry ${item.name}`}>↻</button>
      )}
      <button type="button" className="btn small ghost tv-att-btn" onClick={onRemove} aria-label={`Remove ${item.name}`}>✕</button>
    </li>
  );
}

export function Composer({ taskId, hint, placeholder, onSend }: ComposerProps) {
  const key = `agentify:draft:${taskId}`;
  const filesKey = `agentify:draft-files:${taskId}`;
  const [text, setText] = useState(() => session.get(key) ?? '');
  const [items, setItems] = useState<Pending[]>(() => restore(filesKey));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const aborts = useRef(new Map<string, AbortController>());
  const dragDepth = useRef(0);

  useEffect(() => { setText(session.get(key) ?? ''); setItems(restore(filesKey)); }, [key, filesKey]);
  useEffect(() => { session.set(key, text ? text : null); }, [key, text]);
  useEffect(() => {
    const done = items.filter((i) => i.state === 'done' && i.attachment).map((i) => i.attachment!);
    session.set(filesKey, done.length ? JSON.stringify(done) : null);
  }, [filesKey, items]);

  // Object URLs and uploads in flight end with the composer.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => () => {
    aborts.current.forEach((c) => c.abort());
    itemsRef.current.forEach((i) => { if (i.preview?.startsWith('blob:')) URL.revokeObjectURL(i.preview); });
  }, []);

  // Grow with the text up to a limit, then scroll.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const patch = (k: string, change: Partial<Pending>) => setItems((list) => list.map((i) => (i.key === k ? { ...i, ...change } : i)));

  const upload = useCallback(async (k: string, file: File) => {
    const ctrl = new AbortController();
    aborts.current.set(k, ctrl);
    try {
      let blob: Blob = file;
      let name = file.name || 'pasted-image.png';
      if (isImageFile(file)) {
        patch(k, { state: 'preparing', progress: 0, error: undefined });
        ({ blob, name } = await prepareImage(file).catch(() => ({ blob: file as Blob, name })));
      }
      patch(k, { state: 'uploading', progress: 0, error: undefined, name });
      const attachment = await uploadWithProgress(blob, name, (p) => patch(k, { progress: p }), ctrl.signal);
      patch(k, { state: 'done', progress: 1, attachment, file: undefined });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      patch(k, { state: 'error', error: e instanceof Error ? e.message : 'Upload failed.' });
    } finally {
      aborts.current.delete(k);
    }
  }, []);

  const addFiles = useCallback((files: File[]) => {
    if (!files.length) return;
    setError(null);
    const room = MAX_FILES - itemsRef.current.length;
    if (room <= 0) { setError(`A message can carry at most ${MAX_FILES} files.`); return; }
    if (files.length > room) setError(`Only ${room} more file${room === 1 ? '' : 's'} fit on this message; the rest were left out.`);
    const added: Pending[] = files.slice(0, room).map((file) => {
      const reason = rejectReason(file);
      const image = isImageFile(file);
      return {
        key: `f${++seq}`, name: file.name || 'pasted-image.png', image,
        preview: image && !reason ? URL.createObjectURL(file) : undefined,
        state: reason ? 'error' : image ? 'preparing' : 'uploading', progress: 0, error: reason ?? undefined,
        file: reason ? undefined : file,
      };
    });
    setItems((list) => [...list, ...added]);
    added.forEach((p) => { if (p.file) void upload(p.key, p.file); });
  }, [upload]);

  const remove = (item: Pending) => {
    aborts.current.get(item.key)?.abort();
    if (item.preview?.startsWith('blob:')) URL.revokeObjectURL(item.preview);
    setItems((list) => list.filter((i) => i.key !== item.key));
    requestAnimationFrame(() => ref.current?.focus());
  };

  const ready = items.filter((i) => i.state === 'done' && i.attachment);
  const uploading = items.some((i) => i.state === 'preparing' || i.state === 'uploading');
  const canSend = !sending && !uploading && (!!text.trim() || ready.length > 0);

  const send = async () => {
    const body = text.trim();
    if (!canSend) return;
    setSending(true);
    setError(null);
    const err = await onSend(body, ready.map((i) => i.attachment!));
    setSending(false);
    if (err) setError(err);
    else {
      setText('');
      const sent = new Set(ready.map((i) => i.key));
      items.forEach((i) => { if (sent.has(i.key) && i.preview?.startsWith('blob:')) URL.revokeObjectURL(i.preview); });
      setItems((list) => list.filter((i) => !sent.has(i.key)));
    }
    requestAnimationFrame(() => ref.current?.focus());
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  };

  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files');
  const dragProps = {
    onDragEnter: (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current += 1; setDropping(true); },
    onDragOver: (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; },
    onDragLeave: () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDropping(false); },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDropping(false);
      addFiles([...e.dataTransfer.files]);
    },
  };

  const status = uploading ? 'Uploading files…' : '';

  return (
    <form className="tv-composer" data-dropping={dropping || undefined} onSubmit={(e) => { e.preventDefault(); void send(); }} {...dragProps}>
      <p className="tv-composer-hint" id={`tv-hint-${taskId}`} aria-live="polite">{hint}</p>
      {items.length > 0 && (
        <ul className="tv-att-list" aria-label="Attachments">
          {items.map((item) => (
            <FileItem key={item.key} item={item} onRemove={() => remove(item)} onRetry={() => item.file && void upload(item.key, item.file)} />
          ))}
        </ul>
      )}
      <div className="tv-composer-box">
        <button type="button" className="btn icon ghost tv-attach" aria-label="Attach files" title="Attach images or files (or paste a screenshot)"
          disabled={sending || items.length >= MAX_FILES} onClick={() => input.current?.click()}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 4.5 5.4 9.6a1.4 1.4 0 0 0 2 2l5.3-5.3a2.8 2.8 0 0 0-4-4L3.4 7.6a4.2 4.2 0 0 0 6 6l4.1-4.1" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <input ref={input} type="file" multiple accept={ACCEPT} hidden tabIndex={-1}
          onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={sending}
          placeholder={placeholder}
          aria-label="Message the team"
          aria-describedby={`tv-hint-${taskId}`}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" className="btn primary icon tv-send" disabled={!canSend} aria-label={uploading ? 'Send (waiting for uploads)' : 'Send'}>
          {sending ? <span className="spinner" aria-hidden="true" /> : (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          )}
        </button>
      </div>
      {dropping && <div className="tv-drop" aria-hidden="true">Drop files to attach</div>}
      <span className="sr-only" aria-live="polite">{status}</span>
      {error && <p className="error-text" role="alert">{error}</p>}
    </form>
  );
}
