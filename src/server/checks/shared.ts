/**
 * Small helpers shared by the build checks: positions, theme paths and a
 * JSON parser that accepts the comments Shopify writes into theme JSON.
 *
 * Relative imports in this folder carry their `.ts` extension so the tests
 * run under `node --experimental-strip-types` without a build step.
 */
import type { AutoCheck, BuildFile } from '../../agency/types';

export type Finding = AutoCheck;

/** 1-based line of a character offset. */
export function lineAt(text: string, index: number): number {
  let line = 1;
  const end = Math.min(Math.max(index, 0), text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** "sections/x.liquid" from "./sections/x.liquid", "/sections/x.liquid" or "sections\\x.liquid". */
export function normalizePath(path: string): string {
  return String(path ?? '').replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
}

/** The usable files of a build: string paths and contents, normalized paths. */
export function cleanFiles(files: unknown): BuildFile[] {
  if (!Array.isArray(files)) return [];
  const out: BuildFile[] = [];
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const { path, content } = f as Partial<BuildFile>;
    if (typeof path !== 'string' || typeof content !== 'string' || !path) continue;
    out.push({ path: normalizePath(path), content });
  }
  return out;
}

export const folderOf = (path: string): string => path.split('/')[0] ?? '';
export const isLiquid = (path: string): boolean => path.endsWith('.liquid');
export const isJson = (path: string): boolean => path.endsWith('.json');

/**
 * Blank out /* *\/ and // comments outside strings, keeping every offset and
 * newline, so positions in the result map 1:1 onto the original text.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) { out += text[i + 1]; i += 2; continue; }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; i++; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      let stop = text.indexOf('\n', i);
      if (stop === -1) stop = text.length;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export type JsonResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string; line?: number };

/**
 * Parse theme JSON: comments are allowed (Shopify writes a comment header
 * into generated templates and locales), anything else must be strict JSON.
 * `offset` is where `text` starts within its file, for line numbers.
 */
export function parseJson(text: string, fileText = text, offset = 0): JsonResult {
  const stripped = stripJsonComments(text);
  if (!stripped.trim()) return { ok: false, message: 'The file is empty.', line: lineAt(fileText, offset) };
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const pos = /at position (\d+)/.exec(raw);
    const index = pos ? Number(pos[1]) : /end of JSON input/i.test(raw) ? stripped.length : -1;
    const message = raw.replace(/\s*\(line \d+ column \d+\)/, '').replace(/ in JSON at position \d+/, '');
    return { ok: false, message, line: index >= 0 ? lineAt(fileText, offset + index) : undefined };
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
