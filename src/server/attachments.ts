/**
 * Files the client attaches to messages: screenshots and reference images
 * (shown to the agents), and small documents (listed by name, small text
 * inlined).
 *
 * The type is decided by sniffing the bytes, never by what the browser said:
 * images by their magic numbers (dimensions read from the header), PDFs by
 * theirs, and text by being valid UTF-8 with a known extension. Anything else
 * is refused, SVG included, since it can carry script.
 *
 * Storage goes through getStore(), whose values are JSON: a small metadata
 * document per attachment, and the bytes as base64 in chunks so no single
 * value gets large (Redis REST requests are size-limited).
 */
import { randomUUID } from 'node:crypto';
import type { Attachment } from '../agency/types';
import { HttpError } from './auth';
import { getStore } from './storage';

/** Raw bytes per stored chunk (about 340 KB once base64-encoded). */
const CHUNK_BYTES = 256 * 1024;
/**
 * Claude accepts images up to 5 MB once base64-encoded, and Vercel caps request
 * bodies near 4.5 MB; the app downsizes screenshots to a few hundred KB anyway.
 */
export const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
export const MAX_PDF_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_BYTES = 512 * 1024;
const MAX_WORKSPACE_BYTES = 200 * 1024 * 1024;
const MAX_WORKSPACE_FILES = 2000;
/** Attachments on one message. */
export const MAX_PER_MESSAGE = 10;
const MAX_DIMENSION = 20_000;

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export const isImage = (type: string): type is ImageType => (IMAGE_TYPES as readonly string[]).includes(type);

/** Text formats by extension. Served back as text/plain whatever they are, so none can run as script or style. */
const TEXT_TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json', liquid: 'text/x-liquid',
  css: 'text/css', js: 'text/javascript', csv: 'text/csv',
};

export const isText = (type: string): boolean => Object.values(TEXT_TYPES).includes(type);

interface Stored {
  attachment: Attachment;
  chunks: number;
  createdAt: number;
}

interface WorkspaceUsage {
  bytes: number;
  files: number;
}

const metaKey = (workspaceId: string, id: string) => `att:${workspaceId}:${id}`;
const chunkKey = (workspaceId: string, id: string, i: number) => `attbin:${workspaceId}:${id}:${i}`;
const usageKey = (workspaceId: string) => `attusage:${workspaceId}`;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* ── sniffing ──────────────────────────────────────────────────────── */

const ascii = (b: Uint8Array, at: number, text: string) =>
  b.length >= at + text.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);

interface Sniffed {
  type: string;
  width?: number;
  height?: number;
}

function pngSize(b: Uint8Array): Sniffed | null {
  // Signature, then the IHDR chunk: length(4) "IHDR" width(4) height(4).
  if (b.length < 24 || !ascii(b, 12, 'IHDR')) return null;
  return { type: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegSize(b: Uint8Array): Sniffed | null {
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    if (marker === 0xff) { at += 1; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; } // no length
    const length = u16be(b, at + 2);
    // Start-of-frame markers carry the size; C4 (DHT), C8 (JPG) and CC (DAC) do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { type: 'image/jpeg', height: u16be(b, at + 5), width: u16be(b, at + 7) };
    }
    if (marker === 0xd9 || marker === 0xda || length < 2) return null; // reached the image data without a frame header
    at += 2 + length;
  }
  return null;
}

function gifSize(b: Uint8Array): Sniffed | null {
  if (b.length < 10) return null;
  return { type: 'image/gif', width: u16le(b, 6), height: u16le(b, 8) };
}

function webpSize(b: Uint8Array): Sniffed | null {
  if (b.length < 30) return null;
  if (ascii(b, 12, 'VP8X')) return { type: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (ascii(b, 12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { type: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** What the bytes are, judged from the bytes (and, for text, the extension), or null when not allowed. */
export function sniff(bytes: Uint8Array, name: string): Sniffed | null {
  if (ascii(bytes, 0, '\x89PNG\r\n\x1a\n')) return pngSize(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegSize(bytes);
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return gifSize(bytes);
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return webpSize(bytes);
  if (ascii(bytes, 0, '%PDF-')) return { type: 'application/pdf' };

  const ext = name.toLowerCase().match(/\.([a-z]+)$/)?.[1] ?? '';
  const type = TEXT_TYPES[ext];
  if (!type) return null;
  try {
    const text = utf8.decode(bytes);
    // Binary data that happens to decode is still binary: text has no control characters beyond whitespace.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000e-\u001f\u007f]/.test(text)) return null;
  } catch {
    return null;
  }
  return { type };
}

/** A file name safe to show and to put in a header: no path, no control characters, bounded. */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(-120);
  return clean || 'file';
}

function limitFor(type: string): number {
  if (isImage(type)) return MAX_IMAGE_BYTES;
  if (type === 'application/pdf') return MAX_PDF_BYTES;
  return MAX_TEXT_BYTES;
}

const mb = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;
const kb = (n: number) => (n >= 1024 * 1024 ? mb(n) : `${Math.round(n / 1024)} KB`);

/* ── storage ───────────────────────────────────────────────────────── */

/** Store an uploaded file for a workspace and return its public description. */
export async function saveAttachment(workspaceId: string, file: { name: string; type: string; bytes: Uint8Array }): Promise<Attachment> {
  const name = cleanName(file.name);
  const { bytes } = file;
  if (!bytes.length) throw new HttpError(400, 'empty_file', 'That file is empty.');
  const sniffed = sniff(bytes, name);
  if (!sniffed) {
    throw new HttpError(415, 'unsupported_type',
      'That file type is not supported. Attach PNG, JPEG, WebP or GIF images, PDFs, or text files (txt, md, json, liquid, css, js, csv).');
  }
  if (isImage(sniffed.type) && (!sniffed.width || !sniffed.height || sniffed.width > MAX_DIMENSION || sniffed.height > MAX_DIMENSION)) {
    throw new HttpError(415, 'bad_image', 'That image could not be read.');
  }
  const limit = limitFor(sniffed.type);
  if (bytes.length > limit) throw new HttpError(413, 'too_large', `That file is ${kb(bytes.length)}; the limit for this type is ${kb(limit)}.`);

  const store = getStore();
  const usage = (await store.get<WorkspaceUsage>(usageKey(workspaceId))) ?? { bytes: 0, files: 0 };
  if (usage.files >= MAX_WORKSPACE_FILES || usage.bytes + bytes.length > MAX_WORKSPACE_BYTES) {
    throw new HttpError(413, 'workspace_full', `This workspace has used its attachment storage (${mb(MAX_WORKSPACE_BYTES)} or ${MAX_WORKSPACE_FILES} files).`);
  }

  const id = randomUUID();
  const attachment: Attachment = {
    id, name, type: sniffed.type, size: bytes.length,
    ...(sniffed.width && sniffed.height ? { width: sniffed.width, height: sniffed.height } : {}),
  };
  const chunks = Math.ceil(bytes.length / CHUNK_BYTES);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < chunks; i++) {
    await store.set(chunkKey(workspaceId, id, i), buffer.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).toString('base64'));
  }
  // The metadata goes last: an attachment is visible only once all its bytes are stored.
  await store.set<Stored>(metaKey(workspaceId, id), { attachment, chunks, createdAt: Date.now() });
  // Read-modify-write: concurrent uploads may undercount slightly, which only makes the quota a little soft.
  await store.set<WorkspaceUsage>(usageKey(workspaceId), { bytes: usage.bytes + bytes.length, files: usage.files + 1 });
  return attachment;
}

async function loadMeta(workspaceId: string, id: string): Promise<Stored | null> {
  if (!ID.test(id)) return null;
  return getStore().get<Stored>(metaKey(workspaceId, id));
}

/** The stored bytes of an attachment, scoped to its workspace, or a 404. */
export async function loadAttachment(workspaceId: string, id: string): Promise<{ attachment: Attachment; bytes: Uint8Array }> {
  const meta = await loadMeta(workspaceId, id);
  if (!meta) throw new HttpError(404, 'not_found', 'That attachment does not exist.');
  const keys = Array.from({ length: meta.chunks }, (_, i) => chunkKey(workspaceId, id, i));
  const parts = await getStore().getMany<string>(keys);
  if (parts.some((p) => typeof p !== 'string')) throw new HttpError(404, 'not_found', 'That attachment is incomplete.');
  const bytes = Buffer.concat(parts.map((p) => Buffer.from(p!, 'base64')));
  return { attachment: meta.attachment, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}

/** Resolve attachment ids sent with a message into their descriptions, dropping unknown ids. */
export async function resolveAttachments(workspaceId: string, ids: unknown): Promise<Attachment[]> {
  if (!Array.isArray(ids)) return [];
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && ID.test(id)))];
  if (wanted.length > MAX_PER_MESSAGE) throw new HttpError(400, 'too_many_attachments', `Attach at most ${MAX_PER_MESSAGE} files to one message.`);
  const metas = await getStore().getMany<Stored>(wanted.map((id) => metaKey(workspaceId, id)));
  return metas.filter((m): m is Stored => m !== null).map((m) => m.attachment);
}

/* ── serving ───────────────────────────────────────────────────────── */

/**
 * Headers that keep an uploaded file inert on our origin: the type comes from
 * the allow-list (text of any kind is plain text), nothing is sniffed, only
 * images display inline, and a sandboxing CSP applies if it is opened anyway.
 */
export function serveHeaders(attachment: Attachment): Record<string, string> {
  const inline = isImage(attachment.type);
  const type = inline || attachment.type === 'application/pdf' ? attachment.type : 'text/plain; charset=utf-8';
  const fallback = attachment.name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\;"]/g, '_');
  return {
    'Content-Type': type,
    'Content-Length': String(attachment.size),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    // Ids are never reused, so the bytes never change; private because they are behind a session.
    'Cache-Control': 'private, max-age=86400, immutable',
  };
}
