/**
 * The {% schema %} of sections and theme blocks: present, valid JSON, and a
 * sane shape (name, settings with type and id, unique ids, presets), plus
 * `section.settings.x` / `block.settings.x` references to settings the
 * schema does not define.
 *
 * Theme Check's ValidSchema validates the schema against Shopify's JSON
 * Schema when the engine runs; the shape checks it already covers (a setting
 * that is not an object, a missing id) are only reported here when it did not.
 */
import type { BuildFile } from '../../agency/types';
import { type Finding, folderOf, isLiquid, isObject, lineAt, parseJson } from './shared.ts';

const SCHEMA_RE = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/g;
/** Sidebar settings: display only, no id or label. */
const DISPLAY_SETTINGS = new Set(['header', 'paragraph']);

export interface SchemaOptions {
  /** Files Theme Check ran on: its ValidSchema findings already cover the overlapping shape checks there. */
  checkedByEngine: ReadonlySet<string>;
}

interface FileOptions {
  engine: boolean;
}

interface SchemaBlock {
  /** The JSON text between the tags. */
  text: string;
  /** Offset of `text` in the file. */
  offset: number;
  /** Offsets of the whole tag pair, to skip it when scanning the markup. */
  start: number;
  end: number;
}

export function findSchemas(content: string): SchemaBlock[] {
  const out: SchemaBlock[] = [];
  for (const m of content.matchAll(SCHEMA_RE)) {
    const start = m.index ?? 0;
    const open = m[0].indexOf('%}') + 2;
    out.push({ text: m[1] ?? '', offset: start + open, start, end: start + m[0].length });
  }
  return out;
}

export function checkSchemas(files: BuildFile[], opts: SchemaOptions): { findings: Finding[]; unparseable: Set<string> } {
  const findings: Finding[] = [];
  const unparseable = new Set<string>();
  for (const file of files) {
    const folder = folderOf(file.path);
    if (!isLiquid(file.path) || (folder !== 'sections' && folder !== 'blocks')) continue;
    try {
      findings.push(...checkFile(file, folder === 'sections' ? 'section' : 'block', { engine: opts.checkedByEngine.has(file.path) }, unparseable));
    } catch (err) {
      console.error('checks: schema', file.path, err);
    }
  }
  return { findings, unparseable };
}

function checkFile(file: BuildFile, kind: 'section' | 'block', opts: FileOptions, unparseable: Set<string>): Finding[] {
  const out: Finding[] = [];
  const { path, content } = file;
  const schemas = findSchemas(content);
  if (!schemas.length) {
    const unclosed = /\{%-?\s*schema\s*-?%\}/.exec(content);
    out.push(unclosed
      ? { severity: 'error', check: 'MissingSchema', message: '{% schema %} is never closed with {% endschema %}.', path, line: lineAt(content, unclosed.index) }
      : { severity: 'error', check: 'MissingSchema', message: `A ${kind} needs a {% schema %} tag, or merchants cannot add or configure it in the theme editor.`, path });
    return out;
  }
  const schema = schemas[0];
  const parsed = parseJson(schema.text, content, schema.offset);
  if (!parsed.ok) {
    unparseable.add(path);
    out.push({ severity: 'error', check: 'InvalidSchemaJSON', message: `The {% schema %} is not valid JSON: ${parsed.message}`, path, line: parsed.line });
    return out;
  }
  const value = parsed.value;
  /** Line of the nth (0-based) match of `needle` in the schema, or of the schema start. */
  const at = (needle: RegExp, nth = 0): number => {
    const matches = [...schema.text.matchAll(new RegExp(needle.source, 'g'))];
    const m = matches[Math.min(nth, matches.length - 1)];
    return lineAt(content, schema.offset + (m?.index ?? 0));
  };
  const report = (severity: Finding['severity'], check: string, message: string, line?: number) =>
    out.push({ severity, check, message, path, line: line ?? at(/\S/) });

  if (!isObject(value)) {
    report('error', 'InvalidSchema', 'The {% schema %} must be a JSON object.');
    return out;
  }
  if (typeof value.name !== 'string' || !value.name.trim()) {
    report('error', 'InvalidSchema', `The ${kind} schema has no "name"; the theme editor shows it by name.`);
  }

  const ownIds = checkSettings(value.settings, `The ${kind}`, opts, report, at);

  const localBlockIds = new Set<string>();
  let onlyLocalBlocks = false;
  if (value.blocks !== undefined) {
    if (!Array.isArray(value.blocks)) {
      report('error', 'InvalidSchema', '"blocks" must be an array.', at(/"blocks"/));
    } else {
      onlyLocalBlocks = value.blocks.length > 0;
      const types = new Set<string>();
      value.blocks.forEach((block, i) => {
        if (!isObject(block)) {
          if (!opts.engine) report('error', 'InvalidSchema', `Block ${i + 1} must be an object.`, at(/"blocks"/));
          onlyLocalBlocks = false;
          return;
        }
        const type = typeof block.type === 'string' ? block.type : '';
        if (!type) { report('error', 'InvalidSchema', `Block ${i + 1} has no "type".`, at(/"blocks"/)); return; }
        if (types.has(type)) report('error', 'InvalidSchema', `Block type "${type}" is defined twice.`, at(new RegExp(`"type"\\s*:\\s*"${escapeRe(type)}"`)));
        types.add(type);
        if (type.startsWith('@')) { onlyLocalBlocks = false; return; }
        if (kind === 'section' && (typeof block.name !== 'string' || !block.name.trim())) {
          // A type without a name refers to a theme block (blocks/<type>.liquid), which may live outside this build.
          onlyLocalBlocks = false;
          return;
        }
        const ids = checkSettings(block.settings, `Block "${type}"`, opts, report, at);
        if (ids) for (const id of ids) localBlockIds.add(id);
        else onlyLocalBlocks = false;
      });
    }
  }

  if (value.presets !== undefined && !Array.isArray(value.presets)) {
    report('error', 'InvalidSchema', '"presets" must be an array.', at(/"presets"/));
  } else if (Array.isArray(value.presets)) {
    value.presets.forEach((preset, i) => {
      if (!isObject(preset) || typeof preset.name !== 'string' || !preset.name.trim()) {
        report('error', 'InvalidSchema', `Preset ${i + 1} has no "name".`, at(/"presets"/));
      }
    });
  } else if (kind === 'section' && !Array.isArray(value.enabled_on) && !Array.isArray(value.disabled_on)) {
    report('warning', 'MissingPresets', 'The section has no "presets", so merchants cannot add it from the theme editor; it only appears where a JSON template already places it.');
  }

  // References to settings the schema does not define render as nothing.
  const markup = content.slice(0, schema.start) + content.slice(schema.end);
  const ownObject = kind === 'section' ? 'section' : 'block';
  if (ownIds) out.push(...unknownRefs(path, content, markup, schema, ownObject, ownIds));
  if (kind === 'section' && onlyLocalBlocks) out.push(...unknownRefs(path, content, markup, schema, 'block', localBlockIds));
  return out;
}

/** Validate a settings array; returns its ids, or null when it is not checkable. */
function checkSettings(
  settings: unknown,
  owner: string,
  opts: FileOptions,
  report: (severity: Finding['severity'], check: string, message: string, line?: number) => void,
  at: (needle: RegExp, nth?: number) => number,
): Set<string> | null {
  if (settings === undefined) return new Set();
  if (!Array.isArray(settings)) {
    report('error', 'InvalidSchema', `${owner}: "settings" must be an array.`, at(/"settings"/));
    return null;
  }
  const ids = new Set<string>();
  settings.forEach((setting, i) => {
    if (!isObject(setting)) {
      if (!opts.engine) report('error', 'InvalidSchema', `${owner}: setting ${i + 1} must be an object.`, at(/"settings"/));
      return;
    }
    const type = typeof setting.type === 'string' ? setting.type : '';
    const id = typeof setting.id === 'string' ? setting.id : '';
    const where = id ? at(new RegExp(`"id"\\s*:\\s*"${escapeRe(id)}"`), ids.has(id) ? 1 : 0) : at(/"settings"/);
    if (!type) report('error', 'InvalidSchema', `${owner}: setting ${id ? `"${id}"` : i + 1} has no "type".`, where);
    if (DISPLAY_SETTINGS.has(type)) return;
    if (!id) {
      if (!opts.engine) report('error', 'InvalidSchema', `${owner}: setting ${i + 1}${type ? ` (${type})` : ''} has no "id".`, where);
      return;
    }
    if (ids.has(id)) report('error', 'DuplicateSettingId', `${owner}: setting id "${id}" is used more than once.`, where);
    ids.add(id);
    if (type && setting.label === undefined) report('warning', 'InvalidSchema', `${owner}: setting "${id}" has no "label".`, where);
  });
  return ids;
}

function unknownRefs(path: string, content: string, markup: string, schema: SchemaBlock, object: 'section' | 'block', ids: Set<string>): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const re = new RegExp(`\\b${object}\\.settings\\.([A-Za-z0-9_-]+)`, 'g');
  for (const m of markup.matchAll(re)) {
    const id = m[1];
    if (ids.has(id) || seen.has(id)) continue;
    seen.add(id);
    // Map the offset in `markup` back to the file (the schema was cut out).
    const index = (m.index ?? 0) >= schema.start ? (m.index ?? 0) + (schema.end - schema.start) : (m.index ?? 0);
    out.push({
      severity: 'warning', check: 'UnknownSetting', path, line: lineAt(content, index),
      message: `"${object}.settings.${id}" is not a setting in ${object === 'section' ? 'the schema' : 'the schema\'s blocks'}; it will render as nothing.`,
    });
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
