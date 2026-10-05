/**
 * The app's only door to the server. Every call returns typed data or throws
 * an ApiFailure carrying the server's message and code.
 */
import type {
  ApiError, Attachment, Invite, LiveState, Me, PlanState, Priority, RepoBinding, Store, StoreEnv, Task, TaskSummary, Tier,
  Usage, User, Workspace,
} from '../agency/types';

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiFailure(0, 'network', 'Could not reach the server. Check your connection.');
  }
  const data: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = data as ApiError | null;
    throw new ApiFailure(res.status, err?.code ?? 'error', err?.error ?? `Request failed (${res.status}).`);
  }
  return data as T;
}

/** A repository the GitHub App installation can see. */
export interface RepoOption {
  owner: string;
  repo: string;
  defaultBranch: string;
  private: boolean;
}

/** One plan on offer, for the billing screen. */
export interface PlanOffer {
  tier: Tier;
  name: string;
  /** Display price, e.g. "$2,250". Empty for plans sold by conversation. */
  price: string;
  unit: string;
  /** Monthly token ceiling. */
  tokenLimit: number;
  /** Stores a workspace on this plan may add. */
  storeLimit: number;
  /** Members a workspace on this plan may have. */
  memberLimit: number;
  /** Can be bought through checkout (false: contact us). */
  purchasable: boolean;
}

export interface Billing {
  plan: PlanState;
  usage: Usage;
  offers: PlanOffer[];
}

export interface Members {
  members: User[];
  invites: Invite[];
}

export const api = {
  /* account */
  me: () => request<Me>('GET', '/api/me'),
  updateMe: (patch: { name?: string; notify?: boolean }) => request<User>('PATCH', '/api/me', patch),
  signup: (input: { email: string; password: string; name: string; workspaceName: string }) =>
    request<{ user: User; workspace: Workspace }>('POST', '/api/auth/signup', input),
  login: (input: { email: string; password: string }) => request<{ user: User }>('POST', '/api/auth/login', input),
  logout: () => request<null>('POST', '/api/auth/logout'),

  /* workspace */
  updateWorkspace: (patch: { name?: string; notes?: string }) => request<Workspace>('PATCH', '/api/workspace', patch),

  /* stores: each returns the updated workspace */
  createStore: (input: { label: string; env: StoreEnv }) => request<Workspace>('POST', '/api/stores', input),
  updateStore: (id: string, patch: { label?: string; env?: StoreEnv }) => request<Workspace>('PATCH', `/api/stores/${id}`, patch),
  deleteStore: (id: string) => request<Workspace>('DELETE', `/api/stores/${id}`),
  /** Connect with a pasted custom-app Admin API token. */
  connectShopifyToken: (storeId: string, input: { domain: string; token: string }) =>
    request<Workspace>('PUT', `/api/stores/${storeId}/shopify`, input),
  disconnectShopify: (storeId: string) => request<Workspace>('DELETE', `/api/stores/${storeId}/shopify`),
  /** Where to send the browser to install the Agentify Shopify app on a shop (OAuth). Comes back to /dashboard/settings. */
  shopifyOAuthUrl: (storeId: string, shop: string) =>
    `/api/shopify/oauth/start?store=${encodeURIComponent(storeId)}&shop=${encodeURIComponent(shop)}`,

  /* GitHub */
  /** Where to send the browser to install the Agentify GitHub App. Comes back to /dashboard/settings. */
  githubInstallUrl: () => '/api/github/install',
  disconnectGithub: () => request<Workspace>('DELETE', '/api/github'),
  listRepos: () => request<RepoOption[]>('GET', '/api/github/repos'),
  listBranches: (owner: string, repo: string) =>
    request<string[]>('GET', `/api/github/branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`),
  bindRepo: (storeId: string, binding: RepoBinding) => request<Workspace>('PUT', `/api/stores/${storeId}/repo`, binding),
  unbindRepo: (storeId: string) => request<Workspace>('DELETE', `/api/stores/${storeId}/repo`),

  /* billing */
  billing: () => request<Billing>('GET', '/api/billing'),
  /** Start a checkout for a plan; send the browser to the returned URL. */
  checkout: (tier: Tier) => request<{ url: string }>('POST', '/api/billing/checkout', { tier }),
  /** The customer portal (change card, cancel); send the browser to the returned URL. */
  billingPortal: () => request<{ url: string }>('POST', '/api/billing/portal'),

  /* members */
  members: () => request<Members>('GET', '/api/members'),
  /** Invite someone by email. `link` is the join link, to copy when no email provider is configured. */
  invite: (email: string) => request<{ invite: Invite; link: string; emailed: boolean }>('POST', '/api/invites', { email }),
  revokeInvite: (id: string) => request<null>('DELETE', `/api/invites/${id}`),
  removeMember: (userId: string) => request<null>('DELETE', `/api/members/${userId}`),
  /** Public: what an invitation link is for. */
  inviteInfo: (token: string) => request<{ email: string; workspaceName: string; invitedBy: string }>('GET', `/api/invites/${token}`),
  /** Public: join the workspace an invitation is for, and sign in. */
  acceptInvite: (input: { token: string; name: string; password: string }) =>
    request<{ user: User; workspace: Workspace }>('POST', '/api/auth/accept-invite', input),

  /* tasks */
  listTasks: () => request<TaskSummary[]>('GET', '/api/tasks'),
  /** Open a request from the client's first message. The team starts on it by itself. */
  createTask: (input: { message: string; storeId?: string | null; attachments?: string[] }) => request<Task>('POST', '/api/tasks', input),
  getTask: (id: string) => request<Task>('GET', `/api/tasks/${id}`),
  /** `paused: true` stops the team between steps; `false` resumes it. */
  updateTask: (id: string, patch: { title?: string; priority?: Priority; archived?: boolean; paused?: boolean }) =>
    request<Task>('PATCH', `/api/tasks/${id}`, patch),
  deleteTask: (id: string) => request<null>('DELETE', `/api/tasks/${id}`),
  /** Add a client message to the thread, with the ids of any uploaded attachments. */
  sendMessage: (id: string, text: string, attachments: string[] = []) =>
    request<Task>('POST', `/api/tasks/${id}/messages`, { text, attachments }),
  /** Approve the build at the gate, or return it to the team with a reason. */
  decide: (id: string, decision: 'approve' | 'return', note: string) =>
    request<Task>('POST', `/api/tasks/${id}/gate`, { decision, note }),
  /** Clear a failed step so the team can try it again. */
  retry: (id: string) => request<Task>('POST', `/api/tasks/${id}/retry`),
  /** Nudge the team: starts the next step if one is due and none is running. Harmless otherwise. */
  run: (id: string) => request<Task>('POST', `/api/tasks/${id}/run`),
  /** The cheap poll while watching a request: has it changed, and what is the running step producing? */
  live: (id: string) => request<LiveState>('GET', `/api/tasks/${id}/live`),

  /* attachments */
  /** Upload one file; attach it to a message by passing its id to createTask or sendMessage. */
  upload: async (file: Blob, name: string): Promise<Attachment> => {
    const form = new FormData();
    form.append('file', file, name);
    let res: Response;
    try {
      res = await fetch('/api/attachments', { method: 'POST', credentials: 'same-origin', body: form });
    } catch {
      throw new ApiFailure(0, 'network', 'Could not reach the server. Check your connection.');
    }
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = data as ApiError | null;
      throw new ApiFailure(res.status, err?.code ?? 'error', err?.error ?? `Upload failed (${res.status}).`);
    }
    return data as Attachment;
  },
  /** Where an attachment's bytes are served from (same-origin, signed-in only). */
  attachmentUrl: (id: string) => `/api/attachments/${id}`,
};
