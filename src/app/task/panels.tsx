/**
 * The content side of the task view: one panel per artifact the team has
 * produced (brief, feasibility, design spec, files, review with the automated
 * checks, deploy with the pull request), plus an overview that is always there.
 */
import type { ReactNode } from 'react';
import { AGENTS, PHASE_LABEL, type AutoCheck, type Brief, type Build, type Deploy, type Feasibility, type PullRequest, type Review, type ReviewCheck, type Spec, type Task } from '../../agency/types';
import { nextAgent } from '../../agency/flow';
import { linkClick, paths } from '../router';
import { Markdown } from './Markdown';
import { FilesPanel } from './Files';
import { STAGES, fullTime, stageState, timeOf } from './format';

export type PanelId = 'overview' | 'brief' | 'feasibility' | 'design' | 'files' | 'review' | 'deploy';

export const PANEL_LABEL: Record<PanelId, string> = {
  overview: 'Overview', brief: 'Brief', feasibility: 'Feasibility', design: 'Design',
  files: 'Files', review: 'Review', deploy: 'Deploy',
};

/** The panels that exist for this task, in pipeline order. */
export function availablePanels(task: Task): PanelId[] {
  const list: PanelId[] = ['overview'];
  if (task.brief) list.push('brief');
  if (task.feasibility) list.push('feasibility');
  if (task.spec) list.push('design');
  if (task.build) list.push('files');
  if (task.review || task.build) list.push('review');
  if (task.deploy || task.pullRequest) list.push('deploy');
  return list;
}

/** A count or verdict shown beside a tab label. */
export function panelBadge(task: Task, id: PanelId): { text: string; tone?: string } | null {
  switch (id) {
    case 'files': return task.build ? { text: String(task.build.files.length) } : null;
    case 'review': {
      const errors = task.build?.checks?.filter((c) => c.severity === 'error').length ?? 0;
      if (task.review?.verdict === 'fail') return { text: 'Fail', tone: 'danger' };
      if (errors) return { text: `${errors} error${errors === 1 ? '' : 's'}`, tone: 'danger' };
      return task.review ? { text: 'Pass', tone: 'ok' } : null;
    }
    case 'feasibility': return task.feasibility && task.feasibility.verdict !== 'clear'
      ? { text: task.feasibility.verdict === 'blocked' ? 'Blocked' : 'Questions', tone: task.feasibility.verdict === 'blocked' ? 'danger' : 'warn' } : null;
    case 'deploy': {
      if (task.deploy?.status === 'failed' || task.pullRequest?.status === 'failed') return { text: '!', tone: 'danger' };
      // A pull request is a complete result on its own, even without a preview theme.
      if (task.deploy?.status === 'not_connected' && !task.pullRequest) return { text: '!', tone: 'warn' };
      return null;
    }
    default: return null;
  }
}

/* ── building blocks ─────────────────────────────────────────────────── */

function Section({ title, children, count }: { title: string; children: ReactNode; count?: number }) {
  return (
    <section className="tv-sec">
      <h3 className="tv-sec-title">{title}{count !== undefined && <span className="tv-sec-count">{count}</span>}</h3>
      {children}
    </section>
  );
}

function List({ items, empty = 'None.' }: { items: string[]; empty?: string }) {
  if (!items.length) return <p className="hint">{empty}</p>;
  return <ul className="tv-list">{items.map((t, i) => <li key={i}><Markdown text={t} /></li>)}</ul>;
}

function PanelHead({ title, meta, children }: { title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <header className="tv-panel-head">
      <div>
        <h2>{title}</h2>
        {meta && <p className="tv-panel-meta">{meta}</p>}
      </div>
      {children}
    </header>
  );
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Sieve's check for an acceptance criterion, matched by text, then by position. */
export function checkFor(review: Review | null, criteria: string[], index: number): ReviewCheck | undefined {
  if (!review) return undefined;
  const want = norm(criteria[index]!);
  return review.checks.find((c) => norm(c.criterion) === want)
    ?? review.checks.find((c) => { const n = norm(c.criterion); return n.includes(want) || want.includes(n); })
    ?? (review.checks.length === criteria.length ? review.checks[index] : undefined);
}

/* ── panels ──────────────────────────────────────────────────────────── */

function OverviewPanel({ task, onOpen }: { task: Task; onOpen: (id: PanelId) => void }) {
  const request = task.messages.find((m) => m.from === 'client');
  const next = nextAgent(task);
  const held = nextAgent({ ...task, paused: false });
  const status =
    task.archived ? 'Archived.'
    : task.messages.at(-1)?.kind === 'error' ? 'A step failed. Retry it from the conversation, or add detail for the team.'
    : task.paused && held ? `Paused. ${AGENTS[held].name} continues when you resume.`
    : task.waiting === 'gate' ? 'The build is waiting for your approval.'
    : task.waiting === 'client' ? 'The team is waiting for your reply.'
    : task.phase === 'done' ? 'Done.'
    : next ? `${AGENTS[next].name} is on it: ${AGENTS[next].blurb.charAt(0).toLowerCase()}${AGENTS[next].blurb.slice(1)}`
    : 'Waiting.';
  const artifacts = availablePanels(task).filter((p) => p !== 'overview');
  return (
    <div className="tv-panel">
      <PanelHead title="Overview" meta={<>Opened {timeOf(task.createdAt)} · {PHASE_LABEL[task.phase]}</>} />
      <div className="banner" data-tone={task.messages.at(-1)?.kind === 'error' ? 'danger' : task.waiting === 'gate' || task.waiting === 'client' || task.paused ? 'warn' : undefined}>{status}</div>
      {request && (
        <Section title="Your request">
          <div className="tv-quote"><Markdown text={request.text} /></div>
        </Section>
      )}
      {artifacts.length > 0 && (
        <Section title="Produced so far">
          <div className="tv-chips">
            {artifacts.map((id) => (
              <button key={id} type="button" className="btn small" onClick={() => onOpen(id)}>{PANEL_LABEL[id]}</button>
            ))}
          </div>
        </Section>
      )}
      <Section title="The team on this request">
        <ol className="tv-roster">
          {STAGES.map((s) => {
            const state = task.phase === 'done' ? 'done' : stageState(s, task.phase);
            const profile = s.who === 'client' ? null : AGENTS[s.who];
            return (
              <li key={s.phase} data-state={state}>
                <span className="avatar small" data-who={s.who} aria-hidden="true">{s.name[0]}</span>
                <div>
                  <p><strong>{s.name}</strong> <span className="hint">{profile ? profile.role : 'Approval'}</span></p>
                  <p className="hint">{profile ? profile.blurb : 'You approve the build or send it back with a reason.'}</p>
                </div>
                <span className="tag" data-tone={state === 'done' ? 'ok' : state === 'current' ? 'accent' : undefined}>
                  {state === 'done' ? 'Done' : state === 'current' ? 'Now' : 'Later'}
                </span>
              </li>
            );
          })}
        </ol>
      </Section>
    </div>
  );
}

function BriefPanel({ brief, review }: { brief: Brief; review: Review | null }) {
  const passed = review ? brief.acceptanceCriteria.filter((_, i) => checkFor(review, brief.acceptanceCriteria, i)?.pass).length : 0;
  return (
    <div className="tv-panel">
      <PanelHead title={brief.title || 'Brief'} meta="Written by Atlas" />
      <Markdown text={brief.summary} className="tv-lead" />
      <Section title="Goals" count={brief.goals.length}><List items={brief.goals} /></Section>
      <Section title="User stories" count={brief.userStories.length}><List items={brief.userStories} /></Section>
      <Section title={review ? `Acceptance criteria · ${passed}/${brief.acceptanceCriteria.length} passing` : 'Acceptance criteria'}>
        <ul className="tv-checklist">
          {brief.acceptanceCriteria.map((c, i) => {
            const check = checkFor(review, brief.acceptanceCriteria, i);
            const state = !check ? 'pending' : check.pass ? 'pass' : 'fail';
            return (
              <li key={i} data-state={state}>
                <span className="tv-check" aria-hidden="true">{state === 'pass' ? '✓' : state === 'fail' ? '✕' : ''}</span>
                <span className="sr-only">{state === 'pass' ? 'Passing:' : state === 'fail' ? 'Failing:' : 'Not checked yet:'}</span>
                <div>
                  <Markdown text={c} />
                  {check?.note && <p className="tv-check-note">{check.note}</p>}
                </div>
              </li>
            );
          })}
        </ul>
        {!review && <p className="hint">Sieve checks each criterion once the build is in.</p>}
      </Section>
      <Section title="Out of scope"><List items={brief.outOfScope} /></Section>
    </div>
  );
}

const VERDICT: Record<Feasibility['verdict'], { text: string; tone: string }> = {
  clear: { text: 'Clear to build', tone: 'ok' },
  needs_answers: { text: 'Needs answers', tone: 'warn' },
  blocked: { text: 'Blocked', tone: 'danger' },
};

function FeasibilityPanel({ f }: { f: Feasibility }) {
  return (
    <div className="tv-panel">
      <PanelHead title="Feasibility" meta="Checked by Forge">
        <span className="tag" data-tone={VERDICT[f.verdict].tone}>{VERDICT[f.verdict].text}</span>
      </PanelHead>
      <Section title="Approach"><Markdown text={f.approach} /></Section>
      {f.surfaces.length > 0 && (
        <Section title="Shopify surfaces">
          <div className="tv-chips">{f.surfaces.map((s) => <span key={s} className="tag" data-tone="info">{s}</span>)}</div>
        </Section>
      )}
      {f.questions.length > 0 && <Section title="Open questions" count={f.questions.length}><List items={f.questions} /></Section>}
      {f.blockers.length > 0 && (
        <Section title="Blockers" count={f.blockers.length}><div className="tv-alert-list"><List items={f.blockers} /></div></Section>
      )}
      <Section title="Edge cases" count={f.edgeCases.length}><List items={f.edgeCases} /></Section>
    </div>
  );
}

function DesignPanel({ spec }: { spec: Spec }) {
  return (
    <div className="tv-panel">
      <PanelHead title="Design spec" meta="Written by Muse" />
      <Markdown text={spec.overview} className="tv-lead" />
      <Section title="Layout"><Markdown text={spec.layout} /></Section>
      <Section title="States" count={spec.states.length}><List items={spec.states} /></Section>
      <Section title="Responsive"><Markdown text={spec.responsive} /></Section>
      <Section title="Accessibility" count={spec.accessibility.length}><List items={spec.accessibility} /></Section>
      {spec.copy.length > 0 && (
        <Section title="Copy">
          <dl className="tv-copy">
            {spec.copy.map((line, i) => {
              const at = line.indexOf(':');
              return at > 0 ? (
                <div key={i}><dt>{line.slice(0, at).trim()}</dt><dd>{line.slice(at + 1).trim()}</dd></div>
              ) : <div key={i}><dd>{line}</dd></div>;
            })}
          </dl>
        </Section>
      )}
    </div>
  );
}

const SEVERITY_ORDER: Record<AutoCheck['severity'], number> = { error: 0, warning: 1, info: 2 };
const SEVERITY_LABEL: Record<AutoCheck['severity'], string> = { error: 'Error', warning: 'Warning', info: 'Note' };

/** Findings grouped by file, errors first. */
function byFile(checks: AutoCheck[]): [string, AutoCheck[]][] {
  const groups = new Map<string, AutoCheck[]>();
  for (const c of [...checks].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.line ?? 0) - (b.line ?? 0))) {
    groups.set(c.path, [...(groups.get(c.path) ?? []), c]);
  }
  return [...groups].sort(([, a], [, b]) => SEVERITY_ORDER[a[0]!.severity] - SEVERITY_ORDER[b[0]!.severity]);
}

export function checkCounts(checks: AutoCheck[] | null) {
  return {
    errors: checks?.filter((c) => c.severity === 'error').length ?? 0,
    warnings: checks?.filter((c) => c.severity === 'warning').length ?? 0,
  };
}

/** The automated checks on a build: errors and warnings by file, with line numbers. */
export function AutoChecks({ checks, compact = false }: { checks: AutoCheck[] | null; compact?: boolean }) {
  if (checks === null) {
    return <p className="tv-autocheck-none" data-tone="warn">The automated checks could not run on this build. Sieve reviewed the code by reading it.</p>;
  }
  if (!checks.length) return <p className="tv-autocheck-none" data-tone="ok">No problems found.</p>;
  const shown = compact ? checks.filter((c) => c.severity === 'error') : checks;
  return (
    <div className="tv-autochecks">
      {byFile(shown).map(([path, list]) => (
        <section key={path} className="tv-autocheck-file">
          <h4 className="mono">{path}</h4>
          <ul>
            {list.map((c, i) => (
              <li key={i} data-severity={c.severity}>
                <span className="tag" data-tone={c.severity === 'error' ? 'danger' : c.severity === 'warning' ? 'warn' : 'info'}>{SEVERITY_LABEL[c.severity]}</span>
                {c.line ? <span className="mono tv-autocheck-line">line {c.line}</span> : null}
                <span className="tv-autocheck-msg">{c.message}</span>
                <span className="mono hint tv-autocheck-rule">{c.check}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ReviewPanel({ review, build }: { review: Review | null; build: Build | null }) {
  const failing = review?.checks.filter((c) => !c.pass) ?? [];
  const { errors, warnings } = checkCounts(build?.checks ?? null);
  const autoTitle = build?.checks
    ? `Automated checks · ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`
    : 'Automated checks';
  return (
    <div className="tv-panel">
      <PanelHead title="QA review" meta={<>Checked by Sieve{build ? ` · build round ${build.round}` : ''}</>}>
        {review && <span className="tag" data-tone={review.verdict === 'pass' ? 'ok' : 'danger'}>{review.verdict === 'pass' ? 'Pass' : 'Fail'}</span>}
      </PanelHead>
      {build && (
        <Section title={autoTitle}>
          {errors > 0 && <div className="banner" data-tone="danger" role="note">The linter found {errors} error{errors === 1 ? '' : 's'} in the delivered files.</div>}
          <AutoChecks checks={build.checks} />
        </Section>
      )}
      {review ? (
        <>
          <p className="tv-panel-meta">{review.checks.length - failing.length} of {review.checks.length} checks pass</p>
          <Section title="Checks">
            <ul className="tv-checklist">
              {[...failing, ...review.checks.filter((c) => c.pass)].map((c, i) => (
                <li key={i} data-state={c.pass ? 'pass' : 'fail'}>
                  <span className="tv-check" aria-hidden="true">{c.pass ? '✓' : '✕'}</span>
                  <span className="sr-only">{c.pass ? 'Pass:' : 'Fail:'}</span>
                  <div>
                    <Markdown text={c.criterion} />
                    {c.note && <p className="tv-check-note">{c.note}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </Section>
          {review.issues.length > 0 && <Section title="Issues" count={review.issues.length}><List items={review.issues} /></Section>}
        </>
      ) : (
        <p className="hint">Sieve reviews the build against every acceptance criterion next.</p>
      )}
    </div>
  );
}

const PR_STATUS: Record<PullRequest['status'], { text: string; tone: string }> = {
  opened: { text: 'Opened', tone: 'ok' }, updated: { text: 'Updated', tone: 'ok' }, failed: { text: 'Failed', tone: 'danger' },
};

function PullRequestCard({ pr }: { pr: PullRequest }) {
  return (
    <Section title="Pull request">
      <div className="banner" data-tone={pr.status === 'failed' ? 'danger' : 'ok'}>
        <div>
          <p>
            <span className="tag" data-tone={PR_STATUS[pr.status].tone}>{PR_STATUS[pr.status].text}</span>{' '}
            {pr.status === 'failed' ? (
              <strong>The pull request could not be opened.</strong>
            ) : (
              <>
                {pr.url ? <a href={pr.url} target="_blank" rel="noreferrer noopener"><strong>#{pr.number}</strong> ↗</a> : <strong>#{pr.number}</strong>}
                {pr.branch && <> from <code>{pr.branch}</code></>} · <span title={fullTime(pr.at)}>{timeOf(pr.at)}</span>
              </>
            )}
          </p>
          {pr.status !== 'failed' && <p className="hint">Nothing is merged: review and merge it on GitHub when you are happy.</p>}
          {pr.error && <p className="mono tv-deploy-error">{pr.error}</p>}
        </div>
      </div>
    </Section>
  );
}

function DeployPanel({ deploy, pr }: { deploy: Deploy | null; pr: PullRequest | null }) {
  const at = deploy?.at ?? pr?.at;
  return (
    <div className="tv-panel">
      <PanelHead title="Deploy" meta={<>By Relay{at ? <> · <span title={fullTime(at)}>{timeOf(at)}</span></> : null}</>}>
        {deploy && (deploy.status !== 'not_connected' || !pr) && (
          <span className="tag" data-tone={deploy.status === 'deployed' ? 'ok' : deploy.status === 'failed' ? 'danger' : 'warn'}>
            {deploy.status === 'deployed' ? 'Preview deployed' : deploy.status === 'failed' ? 'Preview failed' : 'Store not connected'}
          </span>
        )}
      </PanelHead>
      {pr && <PullRequestCard pr={pr} />}
      {deploy && <PreviewResult deploy={deploy} hasPr={!!pr} />}
    </div>
  );
}

function PreviewResult({ deploy, hasPr }: { deploy: Deploy; hasPr: boolean }) {
  if (deploy.status === 'not_connected' && hasPr) {
    return <p className="hint">No Shopify store is connected for this request, so there is no preview theme. Connect one in Settings to get a preview next time.</p>;
  }
  return (
    <>
      {deploy.status === 'deployed' && (
        <>
          <div className="banner" data-tone="ok">
            <div>
              <p>Deployed to the unpublished theme <strong>{deploy.themeName ?? deploy.themeId ?? 'preview'}</strong>. Your live theme is untouched.</p>
              {deploy.previewUrl && (
                <p className="tv-deploy-link"><a className="btn small primary" href={deploy.previewUrl} target="_blank" rel="noreferrer noopener">Open preview ↗</a></p>
              )}
            </div>
          </div>
          {deploy.files && deploy.files.length > 0 && (
            <Section title="Files written" count={deploy.files.length}>
              <ul className="tv-list mono">{deploy.files.map((f) => <li key={f}>{f}</li>)}</ul>
            </Section>
          )}
        </>
      )}
      {deploy.status === 'not_connected' && (
        <div className="banner" data-tone="warn">
          <div>
            <p>Relay couldn't deploy because no Shopify store is connected. Connect your store, then ask the team to ship again. You can also download the files and install them yourself.</p>
            <p className="tv-deploy-link"><a className="btn small" href={paths.settings()} onClick={linkClick}>Connect your store</a></p>
          </div>
        </div>
      )}
      {deploy.status === 'failed' && (
        <div className="banner" data-tone="danger">
          <div>
            <p><strong>The preview deploy failed.</strong> Nothing on your store changed.</p>
            {deploy.error && <p className="mono tv-deploy-error">{deploy.error}</p>}
          </div>
        </div>
      )}
    </>
  );
}

export function PanelContent({ id, task, onOpen }: { id: PanelId; task: Task; onOpen: (id: PanelId) => void }) {
  switch (id) {
    case 'overview': return <OverviewPanel task={task} onOpen={onOpen} />;
    case 'brief': return task.brief ? <BriefPanel brief={task.brief} review={task.review} /> : null;
    case 'feasibility': return task.feasibility ? <FeasibilityPanel f={task.feasibility} /> : null;
    case 'design': return task.spec ? <DesignPanel spec={task.spec} /> : null;
    case 'files': return task.build ? <FilesPanel build={task.build} taskNumber={task.number} /> : null;
    case 'review': return task.review || task.build ? <ReviewPanel review={task.review} build={task.build} /> : null;
    case 'deploy': return task.deploy || task.pullRequest ? <DeployPanel deploy={task.deploy} pr={task.pullRequest} /> : null;
  }
}
