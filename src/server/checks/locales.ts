/**
 * Translation keys within a build. The build is only part of a theme, so a
 * key is only judged against locale files that are in the build:
 *
 * - `'ns.key' | t` in the build's Liquid, where the build's default locale
 *   defines `ns` but not the key: a missing translation.
 * - `"t:ns.key"` in a schema, the same against the default schema locale.
 * - A key in the default locale that another locale file of the build lacks.
 *
 * Keys outside the namespaces the build defines are left alone: they live
 * in the theme's own locale files, which we do not see.
 */
import type { BuildFile } from '../../agency/types';
import { findSchemas } from './schema.ts';
import { type Finding, isLiquid, isObject, lineAt, parseJson } from './shared.ts';

const PLURAL_KEYS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const STOREFRONT_REF_RE = /(['"])([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)\1\s*\|\s*(?:t|translate)\b/g;
const SCHEMA_REF_RE = /"t:([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)"/g;

interface Locale {
  path: string;
  data: Record<string, unknown>;
}

export function checkLocales(files: BuildFile[]): Finding[] {
  const findings: Finding[] = [];
  try {
    const storefront: Locale[] = [];
    const schema: Locale[] = [];
    for (const file of files) {
      const m = /^locales\/[^/]+\.json$/.exec(file.path);
      if (!m) continue;
      const parsed = parseJson(file.content);
      if (!parsed.ok || !isObject(parsed.value)) continue; // reported by the JSON check
      (file.path.endsWith('.schema.json') ? schema : storefront).push({ path: file.path, data: parsed.value });
    }
    const isDefault = (l: Locale) => /\.default(\.schema)?\.json$/.test(l.path);
    const defStorefront = storefront.find(isDefault);
    const defSchema = schema.find(isDefault);

    for (const file of files) {
      if (!isLiquid(file.path)) continue;
      const schemas = findSchemas(file.content);
      const inSchema = (i: number) => schemas.some((s) => i >= s.start && i < s.end);
      if (defStorefront) {
        for (const m of file.content.matchAll(STOREFRONT_REF_RE)) {
          if (inSchema(m.index ?? 0)) continue;
          const missing = missingKey(defStorefront.data, m[2]);
          if (missing) findings.push({
            severity: 'warning', check: 'MissingTranslationKey', path: file.path, line: lineAt(file.content, m.index ?? 0),
            message: `'${m[2]}' is not in ${defStorefront.path}, which defines "${m[2].split('.')[0]}" in this build; the storefront will show "translation missing".`,
          });
        }
      }
      if (defSchema) {
        for (const s of schemas) {
          for (const m of s.text.matchAll(SCHEMA_REF_RE)) {
            if (!missingKey(defSchema.data, m[1])) continue;
            findings.push({
              severity: 'warning', check: 'MissingTranslationKey', path: file.path, line: lineAt(file.content, s.offset + (m.index ?? 0)),
              message: `"t:${m[1]}" is not in ${defSchema.path}, which defines "${m[1].split('.')[0]}" in this build; the theme editor will show the raw key.`,
            });
          }
        }
      }
    }

    for (const [def, others] of [[defStorefront, storefront], [defSchema, schema]] as const) {
      if (!def) continue;
      const wanted = leafKeys(def.data);
      for (const locale of others) {
        if (locale === def) continue;
        const have = new Set(leafKeys(locale.data));
        const missing = wanted.filter((k) => !have.has(k));
        if (!missing.length) continue;
        const shown = missing.slice(0, 10).map((k) => `'${k}'`).join(', ');
        findings.push({
          severity: 'warning', check: 'MatchingTranslations', path: locale.path,
          message: `Missing ${missing.length} key${missing.length === 1 ? '' : 's'} that ${def.path} has: ${shown}${missing.length > 10 ? ', …' : ''}.`,
        });
      }
    }
  } catch (err) {
    console.error('checks: locales', err);
  }
  return findings;
}

/** True when the namespace of `key` exists in `data` but the key does not. */
function missingKey(data: Record<string, unknown>, key: string): boolean {
  const parts = key.split('.');
  if (!(parts[0] in data)) return false;
  let node: unknown = data;
  for (const part of parts) {
    if (!isObject(node) || !(part in node)) return true;
    node = node[part];
  }
  // A pluralized entry ({ one, other }) is a valid target for `| t: count: n`.
  return !(typeof node === 'string' || isPlural(node));
}

const isPlural = (node: unknown): boolean =>
  isObject(node) && Object.keys(node).length > 0 && Object.keys(node).every((k) => PLURAL_KEYS.has(k));

/** Dotted paths to every translation, with pluralized entries as one key (plural forms differ per language). */
function leafKeys(data: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObject(v) && !isPlural(v)) out.push(...leafKeys(v, key));
    else out.push(key);
  }
  return out;
}
