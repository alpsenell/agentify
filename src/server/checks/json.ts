/**
 * JSON files of a build: every .json must parse, and JSON templates and
 * section groups must have the shape Shopify accepts (sections, order,
 * block_order pointing at entries that exist).
 *
 * Returns the paths that failed to parse too, so Theme Check's own parse
 * errors on the same files can be dropped as duplicates.
 */
import type { BuildFile } from '../../agency/types';
import { type Finding, folderOf, isJson, isObject, parseJson } from './shared.ts';

export function checkJsonFiles(files: BuildFile[]): { findings: Finding[]; unparseable: Set<string> } {
  const findings: Finding[] = [];
  const unparseable = new Set<string>();
  for (const file of files) {
    if (!isJson(file.path)) continue;
    try {
      const parsed = parseJson(file.content);
      if (!parsed.ok) {
        unparseable.add(file.path);
        findings.push({ severity: 'error', check: 'InvalidJSON', message: `Invalid JSON: ${parsed.message}`, path: file.path, line: parsed.line });
        continue;
      }
      const folder = folderOf(file.path);
      if (folder === 'templates') findings.push(...templateShape(file.path, parsed.value, false));
      else if (folder === 'sections') findings.push(...templateShape(file.path, parsed.value, true));
      else if (folder === 'locales' && !isObject(parsed.value)) {
        findings.push({ severity: 'error', check: 'InvalidJSON', message: 'A locale file must be a JSON object.', path: file.path, line: 1 });
      } else if (file.path === 'config/settings_schema.json' && !Array.isArray(parsed.value)) {
        findings.push({ severity: 'error', check: 'InvalidJSON', message: 'config/settings_schema.json must be a JSON array.', path: file.path, line: 1 });
      }
    } catch (err) {
      console.error('checks: json', file.path, err);
    }
  }
  return { findings, unparseable };
}

/** A JSON template (templates/*.json) or a section group (sections/*.json). */
function templateShape(path: string, value: unknown, group: boolean): Finding[] {
  const out: Finding[] = [];
  const report = (message: string) => out.push({ severity: 'error', check: 'InvalidTemplate', message, path });
  if (!isObject(value)) {
    report(`${group ? 'A section group' : 'A JSON template'} must be a JSON object.`);
    return out;
  }
  if (group) {
    if (typeof value.type !== 'string' || !value.type) report('A section group needs a "type" (e.g. "header", "footer" or "custom.<name>").');
    if (typeof value.name !== 'string' || !value.name) report('A section group needs a "name".');
  }
  const sections = value.sections;
  if (!isObject(sections)) {
    report('"sections" must be an object of section id to section.');
    return out;
  }
  for (const [id, section] of Object.entries(sections)) {
    if (!isObject(section)) { report(`Section "${id}" must be an object.`); continue; }
    if (typeof section.type !== 'string' || !section.type) report(`Section "${id}" has no "type".`);
    if (section.settings !== undefined && !isObject(section.settings)) report(`Section "${id}": "settings" must be an object.`);
    out.push(...blocksShape(path, `Section "${id}"`, section));
  }
  if (!Array.isArray(value.order)) {
    report('"order" must be an array of section ids.');
  } else {
    for (const id of value.order) {
      if (typeof id !== 'string' || !(id in sections)) report(`"order" lists "${String(id)}", which is not in "sections".`);
    }
    if (new Set(value.order).size !== value.order.length) report('"order" lists a section more than once.');
  }
  return out;
}

function blocksShape(path: string, owner: string, entry: Record<string, unknown>): Finding[] {
  const out: Finding[] = [];
  const report = (message: string) => out.push({ severity: 'error', check: 'InvalidTemplate', message, path });
  const { blocks, block_order: order } = entry;
  if (blocks === undefined) return out;
  if (!isObject(blocks)) { report(`${owner}: "blocks" must be an object of block id to block.`); return out; }
  for (const [id, block] of Object.entries(blocks)) {
    if (!isObject(block)) { report(`${owner}: block "${id}" must be an object.`); continue; }
    if (typeof block.type !== 'string' || !block.type) report(`${owner}: block "${id}" has no "type".`);
    out.push(...blocksShape(path, `${owner} > block "${id}"`, block));
  }
  if (order !== undefined) {
    if (!Array.isArray(order)) report(`${owner}: "block_order" must be an array of block ids.`);
    else for (const id of order) {
      if (typeof id !== 'string' || !(id in blocks)) report(`${owner}: "block_order" lists "${String(id)}", which is not in "blocks".`);
    }
  }
  return out;
}
