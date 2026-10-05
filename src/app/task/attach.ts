/**
 * Getting a file ready to attach: images are downscaled in the browser to at
 * most MAX_EDGE on the long side and re-encoded, so a retina screenshot goes
 * up as a few hundred KB; small documents go as they are. Uploads go through
 * XMLHttpRequest because fetch cannot report upload progress.
 */
import type { ApiError, Attachment } from '../../agency/types';
import { ApiFailure } from '../api';

export const MAX_EDGE = 1600;
/** Attachments on one message (the server enforces the same). */
export const MAX_FILES = 10;
/** Images already this small (and no larger than MAX_EDGE) go up untouched. */
const KEEP_BYTES = 400 * 1024;
const QUALITY = 0.85;

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** Server limits, checked here first so the client hears at once. */
const LIMITS: { ext: string[]; max: number; label: string }[] = [
  { ext: ['png', 'jpg', 'jpeg', 'webp', 'gif'], max: 3.5 * 1024 * 1024, label: 'images' },
  { ext: ['pdf'], max: 4 * 1024 * 1024, label: 'PDFs' },
  { ext: ['txt', 'md', 'markdown', 'json', 'liquid', 'css', 'js', 'csv'], max: 512 * 1024, label: 'text files' },
];
export const ACCEPT = [...IMAGE_TYPES, ...LIMITS.flatMap((l) => l.ext.map((e) => `.${e}`))].join(',');

const extOf = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
export const isImageFile = (file: File) => IMAGE_TYPES.includes(file.type) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extOf(file.name));

const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export { size as formatSize };

/** Why a file cannot be attached, or null. */
export function rejectReason(file: File): string | null {
  const ext = extOf(file.name);
  const rule = LIMITS.find((l) => l.ext.includes(ext)) ?? (isImageFile(file) ? LIMITS[0] : undefined);
  if (!rule) return 'Not a supported type. Attach images (PNG, JPEG, WebP, GIF), PDFs or text files.';
  // Images are measured after downscaling.
  if (rule !== LIMITS[0] && file.size > rule.max) return `Too large: ${rule.label} can be up to ${size(rule.max)}.`;
  if (!file.size) return 'The file is empty.';
  return null;
}

function canvasFor(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

const toBlob = (canvas: HTMLCanvasElement, type: string) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, QUALITY));

/**
 * The image to upload: the original when it is already small, otherwise a
 * downscaled WebP (JPEG on a white background where WebP cannot be encoded).
 * Animated GIFs keep their animation unless they are too big to send.
 */
export async function prepareImage(file: File): Promise<{ blob: Blob; name: string }> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  if (scale === 1 && file.size <= KEEP_BYTES) { bitmap.close(); return { blob: file, name: file.name }; }
  if (file.type === 'image/gif' && scale === 1 && file.size <= 3.5 * 1024 * 1024) { bitmap.close(); return { blob: file, name: file.name }; }

  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = canvasFor(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) { bitmap.close(); return { blob: file, name: file.name }; }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);

  let blob = await toBlob(canvas, 'image/webp');
  let ext = 'webp';
  // Safari cannot encode WebP and hands back a PNG instead: use JPEG, flattened onto white.
  if (!blob || blob.type !== 'image/webp') {
    const flat = canvasFor(w, h);
    const fctx = flat.getContext('2d')!;
    fctx.fillStyle = '#fff';
    fctx.fillRect(0, 0, w, h);
    fctx.drawImage(canvas, 0, 0);
    blob = await toBlob(flat, 'image/jpeg');
    ext = 'jpg';
  }
  bitmap.close();
  if (!blob || (scale === 1 && blob.size >= file.size)) return { blob: file, name: file.name };
  const base = file.name.replace(/\.[^.]+$/, '') || 'image';
  return { blob, name: `${base}.${ext}` };
}

/** Upload one file to POST /api/attachments, reporting progress from 0 to 1. */
export function uploadWithProgress(blob: Blob, name: string, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', blob, name);
    xhr.open('POST', '/api/attachments');
    xhr.withCredentials = true;
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(1); resolve(xhr.response as Attachment); return; }
      const err = xhr.response as ApiError | null;
      reject(new ApiFailure(xhr.status, err?.code ?? 'error', err?.error ?? (xhr.status === 413 ? 'That file is too large to upload.' : `Upload failed (${xhr.status}).`)));
    };
    xhr.onerror = () => reject(new ApiFailure(0, 'network', 'Could not reach the server. Check your connection.'));
    xhr.onabort = () => reject(new ApiFailure(0, 'aborted', 'Upload cancelled.'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}
