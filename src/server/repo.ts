/**
 * Reads and writes of workspaces and tasks. Every task read is scoped to a
 * workspace id, so one workspace can never load another's task by guessing
 * an id.
 */
import { randomUUID } from 'node:crypto';
import type { AgentId, Attachment, Message, MessageKind, Sender, Store, Task, TaskSummary, Workspace } from '../agency/types';
import { HttpError, normaliseWorkspace, workspaceKey } from './auth';
import { nextAgent } from '../agency/flow';
import { getStore } from './storage';

const taskKey = (workspaceId: string, taskId: string) => `task:${workspaceId}:${taskId}`;

export async function saveWorkspace(workspace: Workspace): Promise<void> {
  await getStore().set(workspaceKey(workspace.id), workspace);
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const workspace = await getStore().get<Workspace>(workspaceKey(id));
  return workspace ? normaliseWorkspace(workspace) : null;
}

/** The store a task is for, from the workspace's current list (connections may have changed since). */
export const storeOf = (workspace: Workspace, task: Pick<Task, 'storeId'>): Store | null =>
  workspace.stores.find((s) => s.id === task.storeId) ?? null;

export function newMessage(from: Sender, to: Message['to'], kind: MessageKind, text: string, attachments?: Attachment[]): Message {
  return { id: randomUUID(), at: Date.now(), from, to, kind, text, ...(attachments?.length ? { attachments } : {}) };
}

/** Open a task from the client's first message. */
export async function createTask(workspace: Workspace, text: string, storeId: unknown, attachments: Attachment[] = []): Promise<Task> {
  const body = text.trim();
  if (!body) throw new HttpError(400, 'empty_message', 'Describe what you need.');
  if (body.length > 20_000) throw new HttpError(400, 'too_long', 'Keep the request under 20,000 characters.');
  // With no store named, a workspace that has exactly one uses it.
  const store = typeof storeId === 'string'
    ? workspace.stores.find((s) => s.id === storeId)
    : workspace.stores.length === 1 ? workspace.stores[0] : undefined;
  if (typeof storeId === 'string' && !store) throw new HttpError(400, 'unknown_store', 'That store does not exist.');

  // Re-read so two requests filed at once do not share a number.
  const fresh = (await getWorkspace(workspace.id)) ?? workspace;
  fresh.taskSeq += 1;
  await saveWorkspace(fresh);

  const now = Date.now();
  const firstLine = body.split('\n')[0]!.trim();
  const task: Task = {
    id: randomUUID(), number: fresh.taskSeq, workspaceId: workspace.id, storeId: store?.id ?? null,
    title: firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine,
    priority: 'normal', phase: 'discovery', waiting: 'agents', paused: false,
    messages: [newMessage('client', 'atlas', 'chat', body, attachments)],
    brief: null, feasibility: null, spec: null, build: null, review: null, deploy: null, pullRequest: null,
    usage: { input: 0, output: 0 }, lockedUntil: 0, archived: false, createdAt: now, updatedAt: now,
  };
  await saveTask(task);
  return task;
}

export async function getTask(workspaceId: string, taskId: string): Promise<Task> {
  const task = /^[0-9a-f-]{36}$/.test(taskId) ? await getStore().get<Task>(taskKey(workspaceId, taskId)) : null;
  if (!task) throw new HttpError(404, 'not_found', 'That request does not exist.');
  return normaliseTask(task);
}

export async function saveTask(task: Task): Promise<void> {
  task.updatedAt = Date.now();
  await getStore().set(taskKey(task.workspaceId, task.id), task);
}

export async function deleteTask(workspaceId: string, taskId: string): Promise<void> {
  await getTask(workspaceId, taskId);
  await getStore().delete(taskKey(workspaceId, taskId));
}

/** Fill in fields added after a task was stored. */
function normaliseTask(task: Task): Task {
  task.storeId ??= null;
  task.paused ??= false;
  task.pullRequest ??= null;
  if (task.build && task.build.checks === undefined) task.build.checks = null;
  return task;
}

export function summarise(task: Task): TaskSummary {
  const last = task.messages.at(-1) ?? null;
  const next: AgentId | null = nextAgent(task);
  return {
    id: task.id, number: task.number, storeId: task.storeId, title: task.title, priority: task.priority, phase: task.phase,
    waiting: task.waiting, paused: task.paused, archived: task.archived, createdAt: task.createdAt, updatedAt: task.updatedAt,
    nextAgent: next, running: task.lockedUntil > Date.now(),
    lastMessage: last ? { from: last.from, at: last.at, text: last.text.length > 220 ? `${last.text.slice(0, 219)}…` : last.text } : null,
    messageCount: task.messages.length,
  };
}

export async function listTasks(workspaceId: string): Promise<TaskSummary[]> {
  const store = getStore();
  const keys = await store.keys(`task:${workspaceId}:`);
  const tasks = (await store.getMany<Task>(keys)).filter((t): t is Task => t !== null).map(normaliseTask);
  return tasks.map(summarise).sort((a, b) => b.updatedAt - a.updatedAt);
}

/* ── step lock ─────────────────────────────────────────────────────── */

const LOCK_MS = 6 * 60_000;

export const isRunning = (task: Task): boolean => task.lockedUntil > Date.now();

/** Claim the task for one agent step. Throws 409 if a step is already running. */
export async function lockTask(workspaceId: string, taskId: string): Promise<Task> {
  const store = getStore();
  const key = `lock:${taskId}`;
  const now = Date.now();
  if (!(await store.setIfAbsent(key, now + LOCK_MS))) {
    const until = await store.get<number>(key);
    if (until && until > now) throw new HttpError(409, 'locked', 'The team is already working on this request.');
    // The previous step died without releasing: take the lock over.
    await store.set(key, now + LOCK_MS);
  }
  const task = await getTask(workspaceId, taskId);
  task.lockedUntil = now + LOCK_MS;
  await saveTask(task);
  return task;
}

export async function unlockTask(task: Task): Promise<void> {
  task.lockedUntil = 0;
  await saveTask(task);
  await getStore().delete(`lock:${task.id}`);
}
