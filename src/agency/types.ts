/**
 * Shapes shared by the server (src/server) and the app (src/app). Everything
 * here is plain JSON: it is stored as-is and sent over the API as-is.
 *
 * A Task is one client request. It moves through PHASES as the agents hand it
 * to each other; its `messages` are the thread the client reads and writes in.
 */

export const PHASES = ['discovery', 'feasibility', 'design', 'build', 'review', 'gate', 'ship', 'done'] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_LABEL: Record<Phase, string> = {
  discovery: 'Discovery', feasibility: 'Feasibility', design: 'Design', build: 'Build',
  review: 'Review', gate: 'Your approval', ship: 'Shipping', done: 'Done',
};

export const AGENT_IDS = ['atlas', 'forge', 'muse', 'volt', 'sieve', 'relay'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentProfile {
  id: AgentId;
  name: string;
  role: string;
  /** One line shown under the name. */
  blurb: string;
  /** The phase this agent owns. */
  phase: Phase;
}

/** The team, in the order work flows through it. */
export const AGENTS: Record<AgentId, AgentProfile> = {
  atlas: { id: 'atlas', name: 'Atlas', role: 'Product manager', phase: 'discovery',
    blurb: 'Talks with you, pins down what you need and writes the brief.' },
  forge: { id: 'forge', name: 'Forge', role: 'Shopify developer', phase: 'feasibility',
    blurb: 'Checks the brief against Shopify and your store for blockers and edge cases.' },
  muse: { id: 'muse', name: 'Muse', role: 'UI/UX designer', phase: 'design',
    blurb: 'Specifies layout, states, responsive behaviour and copy.' },
  volt: { id: 'volt', name: 'Volt', role: 'Theme engineer', phase: 'build',
    blurb: 'Writes the theme code: sections, snippets, assets.' },
  sieve: { id: 'sieve', name: 'Sieve', role: 'QA', phase: 'review',
    blurb: 'Reviews the build against every acceptance criterion.' },
  relay: { id: 'relay', name: 'Relay', role: 'Release', phase: 'ship',
    blurb: 'Deploys approved work to a preview theme on your store.' },
};

export type Sender = AgentId | 'client' | 'system';

export type MessageKind =
  | 'chat'         // plain conversation
  | 'brief'        // Atlas submitted or updated the brief
  | 'feasibility'  // Forge reported blockers and edge cases
  | 'spec'         // Muse delivered the UI/UX spec
  | 'build'        // Volt delivered files
  | 'review'       // Sieve's verdict
  | 'gate'         // the client approved or returned the work
  | 'deploy'       // Relay's deploy result
  | 'error';       // a step failed

/** A file the client attached to a message. The bytes are served by GET /api/attachments/:id. */
export interface Attachment {
  id: string;
  name: string;
  /** MIME type. Images are shown to the agents; other types are listed by name only. */
  type: string;
  size: number;
  width?: number;
  height?: number;
}

export interface Message {
  id: string;
  at: number;
  from: Sender;
  /** Who the message is addressed to: another agent, the client, or the whole team. */
  to: AgentId | 'client' | 'team';
  kind: MessageKind;
  /** Markdown. */
  text: string;
  attachments?: Attachment[];
}

export interface Brief {
  title: string;
  summary: string;
  goals: string[];
  userStories: string[];
  acceptanceCriteria: string[];
  outOfScope: string[];
}

export interface Feasibility {
  verdict: 'clear' | 'needs_answers' | 'blocked';
  /** How it will be built on Shopify. */
  approach: string;
  /** e.g. "Theme section", "Theme app extension", "Shopify Function", "Flow". */
  surfaces: string[];
  blockers: string[];
  edgeCases: string[];
  /** Questions only the client can answer; non-empty when verdict is needs_answers. */
  questions: string[];
}

export interface Spec {
  overview: string;
  /** Markdown: structure of the UI, top to bottom. */
  layout: string;
  states: string[];
  responsive: string;
  accessibility: string[];
  /** Interface copy, as "where: text". */
  copy: string[];
}

export interface BuildFile {
  /** Theme-relative path, e.g. "sections/size-guide.liquid". */
  path: string;
  content: string;
}

/** One finding from the automated checks (Theme Check and friends) run on a build. */
export interface AutoCheck {
  severity: 'error' | 'warning' | 'info';
  /** The rule that fired, e.g. "LiquidHTMLSyntaxError". */
  check: string;
  message: string;
  path: string;
  line?: number;
}

export interface Build {
  /** 1 for the first build, +1 for each rework. */
  round: number;
  summary: string;
  /** Markdown: how to add it to a theme and configure it. */
  installNotes: string;
  files: BuildFile[];
  /** Findings from the automated checks. Empty when everything is clean; null when they could not run. */
  checks: AutoCheck[] | null;
}

export interface ReviewCheck {
  criterion: string;
  pass: boolean;
  note: string;
}

export interface Review {
  verdict: 'pass' | 'fail';
  checks: ReviewCheck[];
  issues: string[];
}

/** The result of putting the build on an unpublished preview theme. */
export interface Deploy {
  status: 'deployed' | 'not_connected' | 'failed';
  at: number;
  themeId?: string;
  themeName?: string;
  previewUrl?: string;
  /** Files written to the theme. */
  files?: string[];
  error?: string;
}

/** The result of opening a pull request with the build on the store's theme repository. */
export interface PullRequest {
  status: 'opened' | 'updated' | 'failed';
  at: number;
  url?: string;
  number?: number;
  branch?: string;
  error?: string;
}

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** What the task is waiting on right now. */
export type Waiting = 'agents' | 'client' | 'gate' | 'none';

export interface Task {
  id: string;
  /** Per-workspace sequence, shown as "#12". */
  number: number;
  workspaceId: string;
  /** The store this request is for, or null when the workspace has none. */
  storeId: string | null;
  title: string;
  priority: Priority;
  phase: Phase;
  waiting: Waiting;
  /** The client paused the team: no further steps start until it is resumed. */
  paused: boolean;
  messages: Message[];
  brief: Brief | null;
  feasibility: Feasibility | null;
  spec: Spec | null;
  build: Build | null;
  review: Review | null;
  deploy: Deploy | null;
  pullRequest: PullRequest | null;
  /** Token usage across every agent step on this task. */
  usage: { input: number; output: number };
  /** Set while a step is running (ms timestamp when the lock expires). */
  lockedUntil: number;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A task without its heavy fields, for lists and boards. */
export type TaskSummary = Pick<Task,
  'id' | 'number' | 'storeId' | 'title' | 'priority' | 'phase' | 'waiting' | 'paused' | 'archived' | 'createdAt' | 'updatedAt'
> & {
  /** The agent that acts next, when waiting is "agents". */
  nextAgent: AgentId | null;
  /** A step is running right now. */
  running: boolean;
  lastMessage: Pick<Message, 'from' | 'text' | 'at'> | null;
  messageCount: number;
};

export type Role = 'owner' | 'member';

export interface User {
  id: string;
  email: string;
  name: string;
  workspaceId: string;
  role: Role;
  /** Email the user when a request needs them. */
  notify: boolean;
  createdAt: number;
}

/** A pending invitation to join a workspace. */
export interface Invite {
  id: string;
  email: string;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

export const STORE_ENVS = ['development', 'staging', 'production'] as const;
export type StoreEnv = (typeof STORE_ENVS)[number];

/** What the app is told about a Shopify connection. The access token never leaves the server. */
export interface ShopifyConnection {
  domain: string;
  shopName: string;
  connectedAt: number;
  /** Granted access scopes, e.g. ["read_themes", "write_themes"]. */
  scopes: string[];
  /** How the token was obtained: the Agentify app's OAuth install, or a pasted custom-app token. */
  via: 'oauth' | 'token';
}

/** The GitHub repository that holds a store's theme. */
export interface RepoBinding {
  owner: string;
  repo: string;
  /** Pull requests are opened against this branch. */
  baseBranch: string;
  /** Folder in the repository that contains the theme; "" for the repository root. */
  themeRoot: string;
}

/** One Shopify store (or environment of one) that requests are built against. */
export interface Store {
  id: string;
  label: string;
  env: StoreEnv;
  shopify: ShopifyConnection | null;
  repo: RepoBinding | null;
  createdAt: number;
}

/** The workspace's installation of the Agentify GitHub App. */
export interface GitHubInstall {
  installationId: number;
  /** The user or organisation the app is installed on. */
  account: string;
  connectedAt: number;
}

export const PLAN_TIERS = ['trial', 'pilot', 'team', 'studio'] as const;
export type Tier = (typeof PLAN_TIERS)[number];

export interface PlanState {
  tier: Tier;
  status: 'trialing' | 'active' | 'past_due' | 'canceled';
  /** Start and end of the current usage period (ms). */
  periodStart: number;
  periodEnd: number;
}

/** What a workspace has used in the current period, against its plan's ceiling. */
export interface Usage {
  /** Model tokens, input plus output. */
  tokens: number;
  tokenLimit: number;
  /** Agent steps run. */
  steps: number;
}

export interface Workspace {
  id: string;
  name: string;
  /** Free-form notes every agent reads: brand voice, constraints, who the customers are. */
  notes: string;
  stores: Store[];
  github: GitHubInstall | null;
  plan: PlanState;
  taskSeq: number;
  createdAt: number;
}

/** Which integrations the server is configured for. The app hides what cannot work. */
export interface Capabilities {
  /** Claude credentials are present: agents can run. */
  llm: boolean;
  /** The Agentify Shopify app is configured: stores connect with one click (OAuth). */
  shopifyOAuth: boolean;
  /** The Agentify GitHub App is configured. `installUrl` starts the installation. */
  github: boolean;
  /** Stripe is configured: plans can be bought and changed. */
  billing: boolean;
  /** An email provider is configured: invitations and "needs you" emails are sent. */
  email: boolean;
}

/** GET /api/me */
export interface Me {
  user: User;
  workspace: Workspace;
  usage: Usage;
  capabilities: Capabilities;
  /** False when the server has no Claude credentials: agents cannot run. Same as capabilities.llm. */
  llmReady: boolean;
}

/* ── a running step (GET /api/tasks/:id/live) ───────────────────────── */

export interface LiveTool {
  name: string;
  label: string;
  state: 'running' | 'done' | 'failed';
}

/** What the acting agent has produced so far in the step that is running now. */
export interface LiveStep {
  agent: AgentId;
  phase: Phase;
  startedAt: number;
  /** The agent's message so far (Markdown). Grows as the step runs. */
  text: string;
  tools: LiveTool[];
}

/**
 * The cheap poll the app makes while it watches a request. When `updatedAt`
 * differs from the task it holds, the app refetches the task.
 */
export interface LiveState {
  updatedAt: number;
  running: boolean;
  live: LiveStep | null;
}

export interface ApiError {
  error: string;
  /** Machine-readable reason, e.g. "unauthorized", "llm_not_configured", "locked". */
  code: string;
}
