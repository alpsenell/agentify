/**
 * The request frame: a large sheet over the list or board for
 * /dashboard/t/:id. It owns the chrome (breadcrumb, close) and renders the
 * task teammate's TaskView inside, loaded lazily so the shell works before
 * that module exists.
 */
import { Component, lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { Me, Task } from '../../agency/types';
import { api } from '../api';
import { paths } from '../router';
import { applyTask, useApp } from '../state';
import { Modal } from '../ui/Modal';
import { Icon } from '../ui/Icon';
import { PhasePill } from '../ui/bits';

interface TaskViewProps { taskId: string; me: Me; onClose: () => void; onTaskChanged: (task: Task) => void }

// import.meta.glob resolves to {} when the file is absent, so a missing module never breaks the build.
const modules = import.meta.glob<{ default: ComponentType<TaskViewProps> }>('../task/TaskView.tsx');
const loader = modules['../task/TaskView.tsx'];
const TaskView = loader ? lazy(loader) : PendingTaskView;

interface Props {
  /** The open task, or null while the sheet is closed (or closing). */
  taskId: string | null;
  me: Me;
  onClose: () => void;
}

export function TaskSheet({ taskId, me, onClose }: Props) {
  // Keep the last id during the close animation so the content does not vanish first.
  const [shownId, setShownId] = useState(taskId);
  useEffect(() => { if (taskId) setShownId(taskId); }, [taskId]);
  const summary = useApp().tasks?.find((t) => t.id === shownId);

  return (
    <Modal open={taskId !== null} onClose={onClose} variant="sheet" label={summary ? `Request #${summary.number}: ${summary.title}` : 'Request'} className="task-sheet">
      <div className="sheet-bar">
        <nav className="sheet-crumbs" aria-label="Breadcrumb">
          <span className="sheet-crumb">{me.workspace.name}</span>
          <Icon name="chevron" size={12} />
          <span className="sheet-crumb">Requests</span>
          <Icon name="chevron" size={12} />
          <span className="sheet-crumb current">{summary ? `#${summary.number}` : 'Request'}</span>
          {summary && <PhasePill phase={summary.phase} />}
        </nav>
        <div className="sheet-actions">
          {shownId && (
            <a className="btn ghost icon small" href={paths.task(shownId)} target="_blank" rel="noopener" aria-label="Open in a new tab" title="Open in a new tab">
              <Icon name="external" size={14} />
            </a>
          )}
          <button type="button" className="btn ghost icon small" onClick={onClose} aria-label="Close request" title="Close (Esc)" data-autofocus>
            <Icon name="close" />
          </button>
        </div>
      </div>
      <div className="sheet-body">
        {shownId && (
          <SheetBoundary key={shownId}>
            <Suspense fallback={<SheetSkeleton />}>
              <TaskView taskId={shownId} me={me} onClose={onClose} onTaskChanged={applyTask} />
            </Suspense>
          </SheetBoundary>
        )}
      </div>
    </Modal>
  );
}

function SheetSkeleton() {
  return (
    <div className="sheet-skeleton" aria-busy="true" aria-label="Loading request">
      <div className="skeleton" style={{ width: '45%', height: 22 }} />
      <div className="skeleton" style={{ width: '70%', height: 14 }} />
      {[0, 1, 2].map((i) => (
        <div key={i} className="sheet-skeleton-msg">
          <div className="skeleton" style={{ width: 28, height: 28, borderRadius: '50%' }} />
          <div style={{ flex: 1, display: 'grid', gap: 8 }}>
            <div className="skeleton" style={{ width: '30%', height: 12 }} />
            <div className="skeleton" style={{ width: '90%', height: 12 }} />
            <div className="skeleton" style={{ width: '60%', height: 12 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A crash inside the request view stays inside the sheet. */
class SheetBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty" role="alert">
        <h3>This request could not be shown</h3>
        <p>{this.state.error.message}</p>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}

/** Stand-in until src/app/task/TaskView.tsx exists: the thread, read-only. */
function PendingTaskView({ taskId, onTaskChanged }: TaskViewProps) {
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.getTask(taskId).then(
      (t) => { if (live) { setTask(t); onTaskChanged(t); } },
      (err: Error) => { if (live) setError(err.message); },
    );
    return () => { live = false; };
  }, [taskId, onTaskChanged]);
  if (error) return <div className="empty" role="alert"><h3>Could not load this request</h3><p>{error}</p></div>;
  if (!task) return <SheetSkeleton />;
  return (
    <div className="pending-view fade-in">
      <h2>{task.title}</h2>
      <p className="hint">The full request view is still being built. Here is the thread so far.</p>
      {task.messages.map((m) => (
        <div key={m.id} className="pending-msg">
          <span className="avatar small" data-who={m.from} aria-hidden="true">{m.from[0]!.toUpperCase()}</span>
          <div><strong>{m.from}</strong><p>{m.text}</p></div>
        </div>
      ))}
    </div>
  );
}
