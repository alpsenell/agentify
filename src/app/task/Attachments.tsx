/**
 * Attachments in the thread: images as thumbnails that open larger in a
 * lightbox, everything else as download chips. The lightbox is a modal
 * <dialog> (the browser makes the rest of the page inert); Esc closes it,
 * arrow keys step through the message's images, and focus returns to the
 * thumbnail that opened it.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Attachment } from '../../agency/types';
import { api } from '../api';
import { formatSize } from './attach';

const THUMB = 160;

function thumbSize(a: Attachment): { width: number; height: number } {
  if (!a.width || !a.height) return { width: THUMB, height: THUMB };
  const scale = Math.min(1, THUMB / Math.max(a.width, a.height));
  return { width: Math.max(32, Math.round(a.width * scale)), height: Math.max(32, Math.round(a.height * scale)) };
}

function Lightbox({ images, index, onIndex, onClose }: { images: Attachment[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const image = images[index]!;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    // Focus the dialog, not its Close button: the Enter that opened it must not also close it.
    dialog.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  // Keys stop here so the request sheet around the thread does not close or move focus too.
  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowRight' && images.length > 1) onIndex((index + 1) % images.length);
    else if (e.key === 'ArrowLeft' && images.length > 1) onIndex((index - 1 + images.length) % images.length);
  };

  return (
    <dialog ref={ref} className="tv-lightbox" tabIndex={-1} aria-label={`${image.name}${images.length > 1 ? `, image ${index + 1} of ${images.length}` : ''}`}
      onKeyDown={onKeyDown} onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <figure className="tv-lightbox-fig">
        <img src={api.attachmentUrl(image.id)} alt={image.name} width={image.width} height={image.height} />
        <figcaption>
          <span className="tv-lightbox-name">{image.name}</span>
          {image.width && image.height ? <span className="hint"> · {image.width}×{image.height}</span> : null}
          <span className="tv-lightbox-actions">
            {images.length > 1 && (
              <>
                <button type="button" className="btn small" onClick={() => onIndex((index - 1 + images.length) % images.length)} aria-label="Previous image">←</button>
                <span className="hint">{index + 1} / {images.length}</span>
                <button type="button" className="btn small" onClick={() => onIndex((index + 1) % images.length)} aria-label="Next image">→</button>
              </>
            )}
            <a className="btn small" href={api.attachmentUrl(image.id)} download={image.name}>Download</a>
            <button type="button" className="btn small primary" onClick={onClose}>Close</button>
          </span>
        </figcaption>
      </figure>
    </dialog>
  );
}

export function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  const images = attachments.filter((a) => a.type.startsWith('image/'));
  const files = attachments.filter((a) => !a.type.startsWith('image/'));
  const [open, setOpen] = useState<number | null>(null);
  const triggers = useRef<(HTMLButtonElement | null)[]>([]);

  const returnTo = useRef<number | null>(null);
  const close = () => {
    returnTo.current = open;
    setOpen(null);
  };
  // Back to the thumbnail that opened it, once the dialog has gone.
  useEffect(() => {
    if (open !== null || returnTo.current === null) return;
    triggers.current[returnTo.current]?.focus();
    returnTo.current = null;
  }, [open]);

  return (
    <div className="tv-msg-atts">
      {images.length > 0 && (
        <ul className="tv-thumbs" aria-label="Images">
          {images.map((a, i) => {
            const { width, height } = thumbSize(a);
            return (
              <li key={a.id}>
                <button type="button" ref={(el) => { triggers.current[i] = el; }} className="tv-thumb" onClick={() => setOpen(i)}
                  aria-label={`Open ${a.name}`} aria-haspopup="dialog">
                  <img src={api.attachmentUrl(a.id)} alt="" width={width} height={height} loading="lazy" decoding="async" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {files.length > 0 && (
        <ul className="tv-file-chips" aria-label="Files">
          {files.map((a) => (
            <li key={a.id}>
              <a className="tv-file-chip" href={api.attachmentUrl(a.id)} download={a.name} title={`Download ${a.name}`}>
                <span className="tv-att-icon small" aria-hidden="true">{a.name.split('.').pop()?.slice(0, 4).toUpperCase() || 'FILE'}</span>
                <span className="tv-file-chip-name">{a.name}</span>
                <span className="hint">{formatSize(a.size)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {open !== null && images[open] && <Lightbox images={images} index={open} onIndex={setOpen} onClose={close} />}
    </div>
  );
}
