/**
 * Runs one step of a task: the next agent reads the dossier, works with its
 * tools, and hands off. Each step is one HTTP request (see
 * pages/api/tasks/[id]/advance.ts), so a long pipeline never outlives a
 * serverless function and the client sees every hand-off as it happens.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  AGENTS,
  type AgentId, type Brief, type BuildFile, type Feasibility, type Message, type Phase, type Review, type Spec,
  type Store, type Task, type Workspace,
} from '../../agency/types';
import { HttpError } from '../auth';
import { newMessage } from '../repo';
import { assertCanRun } from '../billing';
import { runChecks } from '../checks';
import { openPullRequest } from '../github';
import { deployPreview } from '../shopify';
import { sourceContext, sourceListFiles, sourceReadFile, themeSource } from '../theme-source';
import { MAX_BUILD_ROUNDS, nextAgent, settle } from '../../agency/flow';
import { isFake, llmReady, turn } from './llm';
import { dossierContent, systemPrompt } from './prompts';

/** What a running step reports as it goes; the runner turns these into the live view. */
export type StepEvent =
  | { type: 'start'; agent: AgentId; phase: Phase }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; label: string; state: 'running' | 'done' | 'failed' }
  | { type: 'message'; message: Message };

type Emit = (event: StepEvent) => void;
type Thinker = Exclude<AgentId, 'relay'>;

/* ── tool inputs ───────────────────────────────────────────────────── */

const strings = z.array(z.string());

const BriefInput = z.object({
  title: z.string().describe('A short name for the feature, used as the request title.'),
  summary: z.string().describe('Two or three sentences: what is being built and why.'),
  goals: strings,
  userStories: strings.describe('"As a <who>, I <do what>, so that <why>."'),
  acceptanceCriteria: strings.describe('Checkable facts about the finished feature. QA tests each one.'),
  outOfScope: strings,
});

const FeasibilityInput = z.object({
  verdict: z.enum(['clear', 'needs_answers', 'blocked']),
  approach: z.string().describe('How it will be built on Shopify, and why that way.'),
  surfaces: strings.describe('Shopify surfaces used, e.g. "Theme section", "Metafields", "Shopify Function".'),
  blockers: strings,
  edgeCases: strings.describe('Cases the build must handle.'),
  questions: strings.describe('Questions only the client can answer. Required when the verdict is needs_answers.'),
});

const SpecInput = z.object({
  overview: z.string(),
  layout: z.string().describe('Markdown: the structure of the interface, top to bottom.'),
  states: strings.describe('One entry per state, each describing what the user sees.'),
  responsive: z.string().describe('Behaviour from 375px wide up to desktop.'),
  accessibility: strings,
  copy: strings.describe('Interface copy as "where: text".'),
});

const WriteFileInput = z.object({
  path: z.string().describe('Theme-relative path, e.g. "sections/size-guide.liquid".'),
  content: z.string().describe('The complete file.'),
});

const FinishBuildInput = z.object({
  summary: z.string().describe('What was built, in a few sentences.'),
  installNotes: z.string().describe('Markdown steps a merchant can follow to add and configure it.'),
});

const ReviewInput = z.object({
  verdict: z.enum(['pass', 'fail']),
  checks: z.array(z.object({
    criterion: z.string().describe('The acceptance criterion, as written in the brief.'),
    pass: z.boolean(),
    note: z.string().describe('The evidence: which file, and what in it.'),
  })),
  issues: strings.describe('Defects to fix, each naming the file, what is wrong and what correct looks like.'),
});

const ListFilesInput = z.object({ prefix: z.string().describe('Folder to list, e.g. "sections/". Use "" for everything.') });
const ReadFileInput = z.object({ path: z.string().describe('Theme-relative path of the file to read.') });
const NoInput = z.object({});

interface ToolSpec {
  name: string;
  description: string;
  input: z.ZodType;
  /** Large inputs (file contents) stream as they are generated. */
  eager?: boolean;
}

const tool = (name: string, description: string, input: z.ZodType, eager = false): ToolSpec => ({ name, description, input, eager });

const STORE_TOOLS: ToolSpec[] = [
  tool('get_store_context', 'Read a summary of the client\'s Shopify store: plan, currency, markets, the live theme and the other themes.', NoInput),
  tool('list_theme_files', 'List file paths in the live theme, optionally under one folder.', ListFilesInput),
  tool('read_theme_file', 'Read one file from the live theme.', ReadFileInput),
];

const HANDOFF: Record<Thinker, ToolSpec> = {
  atlas: tool('submit_brief', 'Hand the brief to the team. Call this once you understand what the client needs; the work then moves to feasibility.', BriefInput),
  forge: tool('submit_feasibility', 'Report blockers, edge cases and the build approach, and hand the work on.', FeasibilityInput),
  muse: tool('submit_spec', 'Hand the UI/UX spec to the engineer.', SpecInput),
  volt: tool('finish_build', 'Declare the build complete once every file has been written with write_file.', FinishBuildInput),
  sieve: tool('submit_review', 'Record the review verdict and hand the work on.', ReviewInput),
};

const WRITE_FILE = tool('write_file', 'Create or replace one theme file with its complete content.', WriteFileInput, true);

function toolsFor(agent: Thinker, connected: boolean): ToolSpec[] {
  const store = connected ? STORE_TOOLS : [];
  switch (agent) {
    case 'atlas': return [...(connected ? [STORE_TOOLS[0]!] : []), HANDOFF.atlas];
    case 'forge': return [...store, HANDOFF.forge];
    case 'muse': return [...store, HANDOFF.muse];
    case 'volt': return [...store, WRITE_FILE, HANDOFF.volt];
    case 'sieve': return [HANDOFF.sieve];
  }
}

function toBetaTool(spec: ToolSpec): Anthropic.Beta.BetaTool {
  const { $schema: _schema, ...schema } = z.toJSONSchema(spec.input) as Record<string, unknown>;
  return {
    name: spec.name,
    description: spec.description,
    input_schema: schema as Anthropic.Beta.BetaTool['input_schema'],
    // Eager inputs are not validated by the API, so those are checked with zod below; the rest are strict.
    ...(spec.eager ? { eager_input_streaming: true } : { strict: true }),
  };
}

/* ── limits ────────────────────────────────────────────────────────── */

const EFFORT: Record<Thinker, 'medium' | 'high'> = { atlas: 'medium', forge: 'high', muse: 'medium', volt: 'high', sieve: 'high' };
/** Model round-trips allowed in one step before it is stopped. */
const MAX_TURNS: Record<Thinker, number> = { atlas: 6, forge: 14, muse: 10, volt: 30, sieve: 6 };
const READS_LINKS: readonly Thinker[] = ['atlas', 'forge', 'muse'];
const MAX_FILES = 40;
const MAX_FILE_BYTES = 256 * 1024;
const THEME_PATH = /^(assets|blocks|config|layout|locales|sections|snippets|templates)\/[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

function checkPath(path: string): string | null {
  if (!THEME_PATH.test(path) || path.includes('..') || path.includes('//') || path.length > 200) {
    return 'Use a theme-relative path under assets/, blocks/, config/, layout/, locales/, sections/, snippets/ or templates/.';
  }
  return null;
}

/* ── one thinking agent's step ─────────────────────────────────────── */

interface Outcome {
  text: string;
  /** The validated input of the hand-off tool, if the agent called it. */
  handoff: unknown;
  files: Map<string, string>;
}

async function think(agent: Thinker, task: Task, workspace: Workspace, store: Store | null, emit: Emit): Promise<Outcome> {
  const connected = themeSource(store) !== 'none';
  const specs = toolsFor(agent, connected);
  const tools: Anthropic.Beta.BetaToolUnion[] = specs.map(toBetaTool);
  // Links the client pasted (references, docs) can be read by the agents that scope and design.
  if (READS_LINKS.includes(agent) && !isFake()) tools.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 4 });
  const handoffName = HANDOFF[agent].name;
  // A rework starts from the files already delivered; Volt rewrites only what changes.
  const files = new Map<string, string>(agent === 'volt' ? (task.build?.files ?? []).map((f) => [f.path, f.content]) : []);

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: await dossierContent(agent, task, workspace, store) }];
  let text = '';
  let handoff: unknown;
  let nudged = false;

  for (let i = 0; i < MAX_TURNS[agent]; i++) {
    const reply = await turn({
      agent, system: systemPrompt(agent), messages, tools, effort: EFFORT[agent],
      onText: (delta) => {
        text += delta;
        emit({ type: 'text', delta });
      },
    });
    task.usage.input += (reply.usage.input_tokens ?? 0) + (reply.usage.cache_read_input_tokens ?? 0) + (reply.usage.cache_creation_input_tokens ?? 0);
    task.usage.output += reply.usage.output_tokens ?? 0;

    if (reply.stop_reason === 'refusal') {
      throw new HttpError(422, 'refused', `${AGENTS[agent].name} could not work on this request: the model declined it.`);
    }
    const calls = reply.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (reply.stop_reason === 'max_tokens' && calls.length) {
      throw new HttpError(502, 'truncated', `${AGENTS[agent].name}'s output was cut off. Try the step again.`);
    }
    if (reply.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: reply.content });
      continue;
    }

    if (!calls.length) {
      // Atlas may simply answer the client. Everyone else has to hand off, so remind them once.
      if (agent === 'atlas' || nudged) break;
      nudged = true;
      messages.push({ role: 'assistant', content: reply.content });
      messages.push({ role: 'user', content: `You have not handed off yet. Finish your work and call ${handoffName}.` });
      continue;
    }

    messages.push({ role: 'assistant', content: reply.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const spec = specs.find((s) => s.name === call.name);
      const parsed = spec?.input.safeParse(call.input);
      const fail = (content: string) => results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content });
      if (!spec || !parsed) { fail(`Unknown tool ${call.name}.`); continue; }
      if (!parsed.success) { fail(`Invalid input: ${z.prettifyError(parsed.error)}`); continue; }

      if (call.name === handoffName) {
        if (agent === 'volt' && files.size === 0) { fail('No files have been written. Write the files with write_file first.'); continue; }
        handoff = parsed.data;
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Recorded.' });
        continue;
      }

      const label = toolLabel(call.name, parsed.data);
      emit({ type: 'tool', name: call.name, label, state: 'running' });
      try {
        const content = await runTool(call.name, parsed.data, workspace, store, files);
        results.push({ type: 'tool_result', tool_use_id: call.id, content });
        emit({ type: 'tool', name: call.name, label, state: 'done' });
      } catch (err) {
        fail(err instanceof Error ? err.message : 'The tool failed.');
        emit({ type: 'tool', name: call.name, label, state: 'failed' });
      }
    }
    // The hand-off ends the step: no need to ask the model for a closing remark.
    if (handoff !== undefined) break;
    messages.push({ role: 'user', content: results });
  }

  if (handoff === undefined && agent !== 'atlas') {
    throw new HttpError(502, 'no_handoff', `${AGENTS[agent].name} did not finish this step. Try it again.`);
  }
  return { text: text.trim(), handoff, files };
}

function toolLabel(name: string, input: unknown): string {
  const arg = input as { path?: string; prefix?: string };
  switch (name) {
    case 'get_store_context': return 'Reading the store';
    case 'web_fetch': return 'Reading a linked page';
    case 'list_theme_files': return `Listing theme files${arg.prefix ? ` in ${arg.prefix}` : ''}`;
    case 'read_theme_file': return `Reading ${arg.path}`;
    case 'write_file': return `Writing ${arg.path}`;
    default: return name;
  }
}

async function runTool(name: string, input: unknown, workspace: Workspace, store: Store | null, files: Map<string, string>): Promise<string> {
  switch (name) {
    case 'get_store_context':
      return sourceContext(workspace, store);
    case 'list_theme_files': {
      const { prefix } = input as z.infer<typeof ListFilesInput>;
      const paths = await sourceListFiles(workspace, store, prefix || undefined);
      return paths.length ? paths.join('\n') : 'No files under that prefix.';
    }
    case 'read_theme_file': {
      const { path } = input as z.infer<typeof ReadFileInput>;
      // A file Volt has already rewritten in this build wins over the live theme's copy.
      return files.get(path) ?? sourceReadFile(workspace, store, path);
    }
    case 'write_file': {
      const { path, content } = input as z.infer<typeof WriteFileInput>;
      const bad = checkPath(path);
      if (bad) throw new Error(bad);
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('That file is too large for a theme file (256 KB limit).');
      if (!files.has(path) && files.size >= MAX_FILES) throw new Error(`A build is limited to ${MAX_FILES} files.`);
      files.set(path, content);
      return `Wrote ${path}.`;
    }
    default:
      throw new Error(`Unknown tool ${name}.`);
  }
}

/* ── applying an outcome to the task ───────────────────────────────── */

const bullets = (title: string, items: string[]) => (items.length ? `\n\n**${title}**\n${items.map((i) => `- ${i}`).join('\n')}` : '');

function post(task: Task, emit: Emit, message: Message) {
  task.messages.push(message);
  emit({ type: 'message', message });
}

async function apply(agent: Thinker, task: Task, out: Outcome, emit: Emit) {
  const say = (to: Message['to'], kind: Message['kind'], fallback: string) =>
    post(task, emit, newMessage(agent, to, kind, out.text || fallback));

  switch (agent) {
    case 'atlas': {
      if (out.handoff === undefined) {
        // A plain reply. The phase stays where it is (discovery, gate or done).
        say('client', 'chat', '…');
        return;
      }
      const brief = out.handoff as Brief;
      task.brief = brief;
      task.title = brief.title.slice(0, 120) || task.title;
      // A new brief restarts the pipeline: everything downstream is stale.
      task.feasibility = null; task.spec = null; task.review = null; task.deploy = null; task.pullRequest = null;
      task.phase = 'feasibility';
      say('client', 'brief', `I have written the brief for **${brief.title}** and handed it to Forge.`);
      return;
    }
    case 'forge': {
      const f = out.handoff as Feasibility;
      task.feasibility = f;
      const clear = f.verdict === 'clear';
      task.phase = clear ? 'design' : 'discovery';
      say(clear ? 'muse' : 'atlas', 'feasibility',
        `${f.approach}${bullets('Blockers', f.blockers)}${bullets('Edge cases', f.edgeCases)}${bullets('Questions for the client', f.questions)}`);
      return;
    }
    case 'muse': {
      task.spec = out.handoff as Spec;
      task.phase = 'build';
      say('volt', 'spec', task.spec.overview);
      return;
    }
    case 'volt': {
      const done = out.handoff as z.infer<typeof FinishBuildInput>;
      const files: BuildFile[] = [...out.files].map(([path, content]) => ({ path, content })).sort((a, b) => a.path.localeCompare(b.path));
      emit({ type: 'tool', name: 'checks', label: 'Running Theme Check on the build', state: 'running' });
      const checks = await runChecks(files);
      emit({ type: 'tool', name: 'checks', label: 'Running Theme Check on the build', state: checks === null ? 'failed' : 'done' });
      task.build = { round: (task.build?.round ?? 0) + 1, summary: done.summary, installNotes: done.installNotes, files, checks };
      task.review = null;
      task.phase = 'review';
      say('sieve', 'build', done.summary);
      return;
    }
    case 'sieve': {
      const review = out.handoff as Review;
      task.review = review;
      const rework = review.verdict === 'fail' && (task.build?.round ?? 0) < MAX_BUILD_ROUNDS;
      task.phase = rework ? 'build' : 'gate';
      say(rework ? 'volt' : 'client', 'review',
        review.verdict === 'pass'
          ? 'The build passes review and is ready for your approval.'
          : `The build has issues.${bullets('Issues', review.issues)}`);
      if (review.verdict === 'fail' && !rework) {
        post(task, emit, newMessage('system', 'client', 'chat',
          `Sieve still found issues after ${MAX_BUILD_ROUNDS} builds, so the work is with you: approve it as it is, or return it with what to change.`));
      }
      return;
    }
  }
}

/** Relay does not think: it ships what was approved and reports what happened. */
async function ship(task: Task, workspace: Workspace, store: Store | null, emit: Emit) {
  const lines: string[] = [];

  // A repository gets a pull request: the reviewable, mergeable form of the build.
  if (store?.repo) {
    emit({ type: 'tool', name: 'pull_request', label: 'Opening a pull request', state: 'running' });
    const pr = await openPullRequest(workspace, store, task);
    task.pullRequest = pr;
    emit({ type: 'tool', name: 'pull_request', label: 'Opening a pull request', state: pr && pr.status !== 'failed' ? 'done' : 'failed' });
    if (pr && pr.status !== 'failed') {
      lines.push(`${pr.status === 'updated' ? 'Updated' : 'Opened'} [pull request #${pr.number}](${pr.url}) on \`${store.repo.owner}/${store.repo.repo}\` from branch \`${pr.branch}\`. Nothing is merged: review and merge it when you are happy.`);
    } else {
      lines.push(`The pull request could not be opened: ${pr?.error ?? 'unknown error'}.`);
    }
  }

  // A connected store gets the files on an unpublished preview theme.
  if (store?.shopify) {
    emit({ type: 'tool', name: 'deploy', label: 'Deploying to a preview theme', state: 'running' });
    const deploy = await deployPreview(workspace, store, task);
    task.deploy = deploy;
    emit({ type: 'tool', name: 'deploy', label: 'Deploying to a preview theme', state: deploy.status === 'deployed' ? 'done' : 'failed' });
    if (deploy.status === 'deployed') {
      lines.push(`Deployed ${deploy.files?.length ?? task.build?.files.length ?? 0} files to the unpublished theme **${deploy.themeName}**.${deploy.previewUrl ? ` [Open the preview](${deploy.previewUrl}).` : ''} Nothing on your live theme has changed; publish the preview theme from Shopify admin when you are happy with it.`);
    } else {
      lines.push(`The preview deploy failed: ${deploy.error ?? 'unknown error'}. Nothing on your store has changed.`);
    }
  } else {
    task.deploy = { status: 'not_connected', at: Date.now() };
  }

  if (!store?.repo && !store?.shopify) {
    lines.push('No store or repository is connected for this request, so I have not deployed anything. The files and install notes are in the Files tab: download them and add them to your theme, or connect a store in Settings and I will deploy to a preview theme.');
  } else {
    lines.push('The files and install notes are also in the Files tab.');
  }
  task.phase = 'done';
  post(task, emit, newMessage('relay', 'client', 'deploy', lines.join('\n\n')));
}

/* ── the step ──────────────────────────────────────────────────────── */

/**
 * Run the next agent on `task`, mutating it. The caller holds the task lock
 * and saves the task afterwards.
 */
export async function runStep(task: Task, workspace: Workspace, store: Store | null, emit: Emit): Promise<void> {
  const agent = nextAgent(task);
  if (!agent) throw new HttpError(409, 'nothing_to_do', 'This request is not waiting on the team.');
  emit({ type: 'start', agent, phase: task.phase });

  if (agent === 'relay') {
    await ship(task, workspace, store, emit);
  } else {
    if (!llmReady()) throw new HttpError(503, 'llm_not_configured', 'The agents cannot run: the server has no Claude credentials (ANTHROPIC_API_KEY).');
    await assertCanRun(workspace);
    await apply(agent, task, await think(agent, task, workspace, store, emit), emit);
  }
  settle(task);
}

/** Turn a failed step into something the client can read in the thread. */
export function describeFailure(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return 'The server\'s Claude credentials were rejected. Check ANTHROPIC_API_KEY.';
  if (err instanceof Anthropic.RateLimitError) return 'Claude is rate limiting this workspace right now. Wait a minute and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach Claude. Check the server\'s network and try again.';
  if (err instanceof Anthropic.APIError) return `Claude returned an error (${err.status ?? 'unknown'}). Try the step again.`;
  console.error(err);
  return 'The step failed unexpectedly. Try it again.';
}
