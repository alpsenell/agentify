/**
 * Shopify Theme Check (@shopify/theme-check-common), run in memory on the
 * files of a build: no disk, no network.
 *
 * - The theme is the build's .liquid and .json files behind an in-memory
 *   file system. theme-check-node is not used: it reads the theme and its
 *   config from disk.
 * - Filter, tag and object definitions and Shopify's JSON schemas come from
 *   the snapshot bundled in @shopify/theme-check-docs-updater/data. Its
 *   ThemeLiquidDocsManager is not used: it downloads the latest docs from
 *   GitHub into a cache directory on first use.
 * - A build is only part of a theme, so checks that need the rest of the
 *   theme are disabled (DISABLED, with the reason for each).
 *
 * The engine is loaded on first use (dynamic import) and kept for the life
 * of the instance; a failure to load is remembered and reported as null.
 */
import { createRequire } from 'node:module';
import type { AbstractFileSystem, CheckDefinition, Config, JsonValidationSet, Offense, ThemeDocset } from '@shopify/theme-check-common';
import type { BuildFile } from '../../agency/types';
import { type Finding, isJson, isLiquid } from './shared.ts';

type Engine = typeof import('@shopify/theme-check-common');

const ROOT = 'file:///theme';
const SCHEMA_ROOT = 'https://raw.githubusercontent.com/Shopify/theme-liquid-docs/main/schemas';
const MAX_MESSAGE = 400;

/** Checks that cannot be judged on part of a theme, or do not apply to themes. */
export const DISABLED: Record<string, string> = {
  // The referenced file may exist in the live theme, which we do not see.
  MissingAsset: 'assets referenced by the build may already be in the theme',
  MissingTemplate: 'snippets/sections rendered by the build may already be in the theme',
  JSONMissingSection: 'templates may reference sections that are already in the theme',
  JSONMissingBlock: 'templates may reference blocks that are already in the theme',
  ValidStaticBlockType: 'static blocks may be theme blocks that are already in the theme',
  ValidBlockTarget: 'block types may be theme blocks that are already in the theme',
  ValidScopedCSSClass: 'classes may be defined in theme stylesheets outside the build',
  // Translations live in the theme's locale files; checked within the build in locales.ts instead.
  TranslationKeyExists: 'locale files are usually not in the build (locales.ts checks the ones that are)',
  ValidSchemaTranslations: 'schema locale files are usually not in the build (locales.ts checks the ones that are)',
  MatchingTranslations: 'replaced by the in-build check in locales.ts, at warning severity',
  // Whole-theme views.
  OrphanedSnippet: 'a new snippet is rendered from theme files outside the build',
  // Network: these fetch remote asset URLs to measure them.
  AssetSizeCSS: 'fetches remote stylesheets (network) and sizes theme assets',
  AssetSizeJavaScript: 'fetches remote scripts (network) and sizes theme assets',
};

/** Severity overrides: style advice the QA agent should weigh, not block on. */
const SEVERITY: Record<string, Finding['severity']> = {
  VariableName: 'info',
  LiquidComplexity: 'info',
  LiquidNestingDepth: 'info',
};

const SEVERITIES: Finding['severity'][] = ['error', 'warning', 'info'];

let loading: Promise<{ engine: Engine; docset: ThemeDocset; schemas: JsonValidationSet; checks: CheckDefinition[] } | null> | undefined;

function load() {
  loading ??= (async () => {
    try {
      const mod = (await import('@shopify/theme-check-common')) as Engine & { default?: Engine };
      const engine = (mod.default && typeof mod.default.check === 'function' ? mod.default : mod) as Engine;
      // Literal specifiers so the function bundler (nft) traces these files.
      const require = createRequire(import.meta.url);
      const data = {
        filters: require('@shopify/theme-check-docs-updater/data/filters.json'),
        objects: require('@shopify/theme-check-docs-updater/data/objects.json'),
        tags: require('@shopify/theme-check-docs-updater/data/tags.json'),
        systemTranslations: require('@shopify/theme-check-docs-updater/data/shopify_system_translations.json'),
        manifest: require('@shopify/theme-check-docs-updater/data/manifest_theme.json') as { schemas: { uri: string; fileMatch?: string[] }[] },
      };
      const schemaFiles: Record<string, unknown> = {
        'theme/translations.json': require('@shopify/theme-check-docs-updater/data/translations.json'),
        'theme/theme_block.json': require('@shopify/theme-check-docs-updater/data/theme_block.json'),
        'theme/theme_settings.json': require('@shopify/theme-check-docs-updater/data/theme_settings.json'),
        'theme/section.json': require('@shopify/theme-check-docs-updater/data/section.json'),
        'theme/settings.json': require('@shopify/theme-check-docs-updater/data/settings.json'),
        'theme/setting.json': require('@shopify/theme-check-docs-updater/data/setting.json'),
        'theme/default_setting_values.json': require('@shopify/theme-check-docs-updater/data/default_setting_values.json'),
        'theme/app_block_entry.json': require('@shopify/theme-check-docs-updater/data/app_block_entry.json'),
        'theme/theme_block_entry.json': require('@shopify/theme-check-docs-updater/data/theme_block_entry.json'),
        'theme/targetted_block_entry.json': require('@shopify/theme-check-docs-updater/data/targetted_block_entry.json'),
        'theme/preset_blocks.json': require('@shopify/theme-check-docs-updater/data/preset_blocks.json'),
        'theme/preset.json': require('@shopify/theme-check-docs-updater/data/preset.json'),
        'theme/local_block_entry.json': require('@shopify/theme-check-docs-updater/data/local_block_entry.json'),
      };
      const docset = new engine.AugmentedThemeDocset({
        filters: async () => data.filters,
        objects: async () => data.objects,
        liquidDrops: async () => data.objects,
        tags: async () => data.tags,
        systemTranslations: async () => data.systemTranslations,
      });
      // Schemas reference each other by relative URL; the validator resolves them from this list, never the network.
      const definitions = data.manifest.schemas
        .filter((s) => schemaFiles[s.uri] !== undefined)
        .map((s) => ({ uri: `${SCHEMA_ROOT}/${s.uri}`, fileMatch: s.fileMatch, schema: JSON.stringify(schemaFiles[s.uri]) }));
      const schemas: JsonValidationSet = { schemas: async () => definitions };
      const checks = (engine.allChecks as CheckDefinition[]).filter((c) => {
        const targets = (c.meta.targets ?? []) as string[];
        // Theme app extension checks only run in that mode.
        if (targets.length && targets.every((t) => t === 'theme-app-extension')) return false;
        return !(c.meta.code in DISABLED);
      });
      return { engine, docset, schemas, checks };
    } catch (err) {
      console.error('checks: Theme Check failed to load', err);
      return null;
    }
  })();
  return loading;
}

/** Where Theme Check puts its results as it goes, so a caller that stops waiting still has them. */
export interface ThemeCheckSink {
  findings: Finding[];
  /** Paths of the files checked so far. */
  checked: Set<string>;
  /** Liquid and JSON files in the build. */
  total: number;
}

/**
 * Run Theme Check on the build, one file at a time so the deadline is
 * honoured between files. False when the engine could not load.
 */
export async function runThemeCheck(files: BuildFile[], deadline: number, sink: ThemeCheckSink): Promise<boolean> {
  const loaded = await load();
  if (!loaded) return false;
  const { engine, docset, schemas, checks } = loaded;

  const targets = files.filter((f) => isLiquid(f.path) || isJson(f.path));
  sink.total = targets.length;
  const fs = memoryFs(new Map(files.map((f) => [f.path, f.content])));
  const config: Config = { context: 'theme', settings: {}, checks, rootUri: ROOT, onError: (err) => console.error('checks: Theme Check', err) };
  const deps = { fs, themeDocset: docset, jsonValidationSet: schemas };

  for (const file of targets) {
    if (Date.now() >= deadline) break;
    try {
      const source = engine.toSourceCode(`${ROOT}/${file.path}`, file.content);
      const offenses: Offense[] = await engine.check([source], config, deps);
      for (const o of offenses) sink.findings.push(toFinding(o, file.path));
    } catch (err) {
      console.error('checks: Theme Check', file.path, err);
    }
    sink.checked.add(file.path);
    // Parsing and visiting are synchronous; yield so the caller's timer can fire between files.
    await new Promise((r) => setImmediate(r));
  }
  return true;
}

function toFinding(o: Offense, path: string): Finding {
  const severity = SEVERITY[o.check] ?? SEVERITIES[o.severity as number] ?? 'warning';
  const message = o.message.length > MAX_MESSAGE ? `${o.message.slice(0, MAX_MESSAGE - 1)}…` : o.message;
  // Theme Check positions use 0-based lines despite the type's comment.
  const line = typeof o.start?.line === 'number' && o.start.line >= 0 ? o.start.line + 1 : undefined;
  return { severity, check: o.check, message, path, line };
}

/** A read-only file system over the build, for the few checks that look up other files. */
function memoryFs(byPath: Map<string, string>): AbstractFileSystem {
  const rel = (uri: string) => decodeURIComponent(uri.startsWith(ROOT) ? uri.slice(ROOT.length) : uri).replace(/^\/+/, '');
  const isDir = (p: string) => p === '' || [...byPath.keys()].some((k) => k.startsWith(`${p}/`));
  const fs = {
    async stat(uri: string) {
      const p = rel(uri);
      const content = byPath.get(p);
      if (content !== undefined) return { type: 1, size: Buffer.byteLength(content) };
      if (isDir(p)) return { type: 2, size: 0 };
      throw new Error(`ENOENT: ${uri}`);
    },
    async readFile(uri: string) {
      const content = byPath.get(rel(uri));
      if (content === undefined) throw new Error(`ENOENT: ${uri}`);
      return content;
    },
    async readDirectory(uri: string) {
      const p = rel(uri);
      const prefix = p ? `${p}/` : '';
      const entries = new Map<string, number>();
      for (const k of byPath.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const name = rest.split('/')[0];
        entries.set(`${ROOT}/${prefix}${name}`, rest.includes('/') ? 2 : 1);
      }
      return [...entries];
    },
  };
  // FileType is a TS enum (File = 1, Directory = 2); plain numbers keep this file free of runtime imports.
  return fs as unknown as AbstractFileSystem;
}
