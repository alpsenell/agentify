/**
 * Automated checks on a build, run before QA reads it.
 *
 * Two layers, merged into one list:
 * - Shopify Theme Check, in memory, tuned for a partial theme (theme-check.ts).
 *   Loaded lazily, so it costs nothing to functions that never run checks.
 * - Direct checks that need no engine and know the build is partial: JSON
 *   validity and template shape (json.ts), section/block schemas (schema.ts)
 *   and translation keys within the build (locales.ts).
 *
 * Bounded: Theme Check gets what is left of TIME_LIMIT_MS and is abandoned
 * at the deadline, keeping the files it finished; the list is capped at
 * MAX_FINDINGS, errors first.
 */
import type { AutoCheck, BuildFile } from '../../agency/types';
import { checkJsonFiles } from './json.ts';
import { checkLocales } from './locales.ts';
import { checkSchemas } from './schema.ts';
import { cleanFiles } from './shared.ts';
import { runThemeCheck, type ThemeCheckSink } from './theme-check.ts';

const TIME_LIMIT_MS = 10_000;
const MAX_FINDINGS = 100;
/** Repeats of one rule in one file beyond this are summarized in a single entry. */
const MAX_PER_RULE_AND_FILE = 5;
const RANK: Record<AutoCheck['severity'], number> = { error: 0, warning: 1, info: 2 };

/**
 * Lint the files of a build (Theme Check, schema JSON, syntax). Returns the
 * findings, an empty array when clean, or null when the checks could not run.
 * Never throws.
 *
 * When only Theme Check fails to load or runs out of time, the direct checks'
 * findings are still returned, with an info entry saying what was skipped.
 */
export async function runChecks(files: BuildFile[], opts: { timeLimitMs?: number } = {}): Promise<AutoCheck[] | null> {
  try {
    const deadline = Date.now() + (opts.timeLimitMs ?? TIME_LIMIT_MS);
    const build = cleanFiles(files);
    if (!build.length) return [];

    const sink: ThemeCheckSink = { findings: [], checked: new Set(), total: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      runThemeCheck(build, deadline, sink).then((ok): 'done' | 'unavailable' => (ok ? 'done' : 'unavailable'))
        .catch((err): 'unavailable' => { console.error('checks: Theme Check', err); return 'unavailable'; }),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now())); }),
    ]);
    clearTimeout(timer);

    const json = checkJsonFiles(build);
    const schema = checkSchemas(build, { checkedByEngine: sink.checked });
    const locales = checkLocales(build);

    // Drop Theme Check's reports of parse errors the direct checks already made, with a line.
    const engine = sink.findings.filter((f) => {
      if (json.unparseable.has(f.path) && (f.check === 'JSONSyntaxError' || f.check === 'ValidJSON')) return false;
      if (schema.unparseable.has(f.path) && f.check === 'ValidSchema') return false;
      if (f.check === 'LiquidSyntaxError') {
        return !sink.findings.some((g) => g.check === 'LiquidHTMLSyntaxError' && g.path === f.path && g.line === f.line);
      }
      return true;
    });

    const notes: AutoCheck[] = [];
    if (outcome === 'unavailable') {
      notes.push({ severity: 'info', check: 'ThemeCheck', path: '', message: 'Theme Check could not run; only the JSON, schema and translation checks ran.' });
    } else if (outcome === 'timeout' && !sink.total) {
      notes.push({ severity: 'info', check: 'ThemeCheck', path: '', message: 'Theme Check did not start within the time limit; only the JSON, schema and translation checks ran.' });
    } else if (sink.checked.size < sink.total) {
      notes.push({ severity: 'info', check: 'ThemeCheck', path: '', message: `Theme Check reached the time limit after ${sink.checked.size} of ${sink.total} files; the rest had only the JSON, schema and translation checks.` });
    }

    const seen = new Set<string>();
    const all = [...json.findings, ...schema.findings, ...locales, ...engine].filter((f) => {
      const key = `${f.path}\u0000${f.line ?? ''}\u0000${f.check}\u0000${f.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    all.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
    const shown = collapseRepeats(all);

    const room = MAX_FINDINGS - notes.length;
    if (shown.length > room) {
      const kept = shown.slice(0, room - 1);
      notes.push({ severity: 'info', check: 'ThemeCheck', path: '', message: `${shown.length - kept.length} more findings not shown.` });
      return [...kept, ...notes];
    }
    return [...shown, ...notes];
  } catch (err) {
    console.error('checks: failed', err);
    return null;
  }
}

/** Keep the first few findings of a rule in a file and summarize the rest, so one noisy file cannot fill the list. */
function collapseRepeats(findings: AutoCheck[]): AutoCheck[] {
  const counts = new Map<string, number>();
  for (const f of findings) {
    const key = `${f.path}\u0000${f.check}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: AutoCheck[] = [];
  const emitted = new Map<string, number>();
  for (const f of findings) {
    const key = `${f.path}\u0000${f.check}`;
    const n = (emitted.get(key) ?? 0) + 1;
    emitted.set(key, n);
    if (n <= MAX_PER_RULE_AND_FILE) out.push(f);
    else if (n === MAX_PER_RULE_AND_FILE + 1) {
      const rest = (counts.get(key) ?? 0) - MAX_PER_RULE_AND_FILE;
      out.push({ severity: f.severity, check: f.check, path: f.path, line: f.line, message: `${rest} more ${f.check} finding${rest === 1 ? '' : 's'} in this file, from this line on.` });
    }
  }
  return out;
}
