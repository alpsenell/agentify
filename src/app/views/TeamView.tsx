/**
 * The team (/dashboard/team): the six agents in hand-off order, what each
 * owns, and what each is doing right now across the client's open requests.
 */
import { AGENTS, AGENT_IDS, PHASE_LABEL, type AgentId, type TaskSummary } from '../../agency/types';
import { linkClick, paths } from '../router';
import { Icon } from '../ui/Icon';
import { PhasePill } from '../ui/bits';
import { byPriority, groupOf } from '../ui/format';
import './views.css';

export function TeamView({ tasks }: { tasks: TaskSummary[] | null }) {
  const open = (tasks ?? []).filter((t) => !t.archived);
  const working = (id: AgentId) => open.filter((t) => t.nextAgent === id).sort(byPriority);
  const needsYou = open.filter((t) => groupOf(t) === 'needs');
  const active = open.filter((t) => t.nextAgent !== null).length;
  const done = open.filter((t) => t.phase === 'done').length;

  // The relay with the client's approval between QA and release.
  const steps: (AgentId | 'you')[] = ['atlas', 'forge', 'muse', 'volt', 'sieve', 'you', 'relay'];

  return (
    <div className="view team-view">
      <section className="team-stats fade-in" aria-label="At a glance">
        <div className="stat"><span className="stat-n">{tasks ? active : '–'}</span><span>being worked on</span></div>
        <div className="stat" data-tone={needsYou.length ? 'accent' : undefined}><span className="stat-n">{tasks ? needsYou.length : '–'}</span><span>waiting on you</span></div>
        <div className="stat"><span className="stat-n">{tasks ? done : '–'}</span><span>done</span></div>
      </section>

      <section className="handoff card fade-in" aria-labelledby="handoff-title">
        <h2 id="handoff-title" className="section-title">How work flows</h2>
        <p className="section-sub">Each agent finishes its part and hands the request to the next. Nothing ships until you approve it.</p>
        <ol className="flow">
          {steps.map((s, i) => {
            const busy = s === 'you' ? needsYou.length : working(s).length;
            const name = s === 'you' ? 'You' : AGENTS[s].name;
            const role = s === 'you' ? 'Approve' : AGENTS[s].role;
            return (
              <li key={s} className="flow-step" data-busy={busy > 0} data-you={s === 'you' || undefined}>
                <span className="avatar" data-who={s === 'you' ? 'client' : s} aria-hidden="true">{name[0]}</span>
                <span className="flow-name">{name}</span>
                <span className="flow-role">{role}</span>
                <span className="flow-busy">{busy > 0 ? `${busy} ${s === 'you' ? 'waiting' : 'active'}` : 'idle'}</span>
                {i < steps.length - 1 && <Icon name="arrow" size={14} className="flow-arrow" />}
              </li>
            );
          })}
        </ol>
      </section>

      <div className="agents">
        {AGENT_IDS.map((id, i) => {
          const a = AGENTS[id];
          const now = working(id);
          return (
            <article key={id} className="agent card fade-in" style={{ animationDelay: `${i * 40}ms` }} data-busy={now.length > 0}>
              <header className="agent-head">
                <span className="avatar large" data-who={id} aria-hidden="true">{a.name[0]}</span>
                <div className="agent-id">
                  <h3>{a.name}</h3>
                  <span>{a.role}</span>
                </div>
                <PhasePill phase={a.phase} />
              </header>
              <p className="agent-blurb">{a.blurb}</p>
              <div className="agent-now">
                <span className="label">Right now</span>
                {tasks === null ? <span className="skeleton" style={{ width: '60%', height: 12 }} />
                  : now.length === 0 ? <span className="agent-idle">Idle, waiting for a hand-off into {PHASE_LABEL[a.phase].toLowerCase()}</span>
                  : (
                    <ul className="agent-tasks">
                      {now.slice(0, 3).map((t) => (
                        <li key={t.id}>
                          {t.running ? <span className="actor-live" aria-hidden="true" title="Working on it now" /> : <span className="actor-next" aria-hidden="true" title="Up next" />}
                          <a href={paths.task(t.id)} onClick={linkClick}><span className="mono">#{t.number}</span> {t.title}</a>
                        </li>
                      ))}
                      {now.length > 3 && <li className="agent-more">and {now.length - 3} more</li>}
                    </ul>
                  )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
