/**
 * Invitations, over an injected key-value store. No imports from the rest of
 * the server, so it runs under plain Node in tests (see members.test.mjs);
 * index.ts adds sessions, accounts and email.
 *
 * The link carries a random token; only its SHA-256 is stored, so a leaked
 * database cannot be turned into working links. One pending invitation per
 * email per workspace, enforced with setIfAbsent on an email index.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Invite } from '../../agency/types';
import type { Store as KV } from '../storage';

export const INVITE_DAYS = 7;
const DAY = 86_400_000;

export interface StoredInvite extends Invite {
  workspaceId: string;
  tokenHash: string;
}

export class InviteError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const inviteKey = (workspaceId: string, id: string) => `invite:${workspaceId}:${id}`;
const tokenKey = (hash: string) => `invite-token:${hash}`;
const emailIndexKey = (workspaceId: string, email: string) => `invite-email:${workspaceId}:${email}`;
const claimKey = (hash: string) => `invite-claim:${hash}`;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const normalEmail = (email: unknown) => (typeof email === 'string' ? email.trim().toLowerCase() : '');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const publicInvite = ({ id, email, invitedBy, createdAt, expiresAt }: StoredInvite): Invite => ({ id, email, invitedBy, createdAt, expiresAt });

async function drop(kv: KV, invite: StoredInvite): Promise<void> {
  await kv.delete(tokenKey(invite.tokenHash));
  // Only clear the email index if it still points at this invitation.
  if ((await kv.get<string>(emailIndexKey(invite.workspaceId, invite.email))) === invite.id) {
    await kv.delete(emailIndexKey(invite.workspaceId, invite.email));
  }
  await kv.delete(inviteKey(invite.workspaceId, invite.id));
}

/** Pending, unexpired invitations, oldest first. Expired ones are cleared on the way. */
export async function listInvites(kv: KV, workspaceId: string, now = Date.now()): Promise<StoredInvite[]> {
  const all = (await kv.getMany<StoredInvite>(await kv.keys(`invite:${workspaceId}:`))).filter((i): i is StoredInvite => !!i);
  const live: StoredInvite[] = [];
  for (const invite of all) {
    if (invite.expiresAt <= now) await drop(kv, invite);
    else live.push(invite);
  }
  return live.sort((a, b) => a.createdAt - b.createdAt);
}

export interface CreateInput {
  workspaceId: string;
  email: unknown;
  /** The inviter's name, shown on the join screen and in the email. */
  invitedBy: string;
  /** Whether an account already uses this email (anywhere: one account belongs to one workspace). */
  accountExists: (email: string) => Promise<boolean>;
  /** Runs after the email is validated and before anything is written; throw to refuse (the seat limit). */
  beforeCreate?: () => void | Promise<void>;
  now?: number;
}

/** Create an invitation. Returns it with the raw token, which is never stored. */
export async function createInvite(kv: KV, input: CreateInput): Promise<{ invite: StoredInvite; token: string }> {
  const now = input.now ?? Date.now();
  const email = normalEmail(input.email);
  if (!EMAIL.test(email) || email.length > 200) throw new InviteError(400, 'invalid_email', 'Enter a valid email address.');
  if (await input.accountExists(email)) {
    throw new InviteError(409, 'email_taken', `${email} already has an Agentify account. An account belongs to one workspace, so they would need to use a different email.`);
  }

  const index = emailIndexKey(input.workspaceId, email);
  const pendingId = await kv.get<string>(index);
  const pending = pendingId ? await kv.get<StoredInvite>(inviteKey(input.workspaceId, pendingId)) : null;
  if (pending && pending.expiresAt > now) {
    throw new InviteError(409, 'already_invited', `${email} already has a pending invitation. Revoke it first to send a new link.`);
  }
  await input.beforeCreate?.();

  const id = randomUUID();
  if (!(await kv.setIfAbsent(index, id))) {
    const existingId = await kv.get<string>(index);
    const existing = existingId ? await kv.get<StoredInvite>(inviteKey(input.workspaceId, existingId)) : null;
    if (existing && existing.expiresAt > now) {
      throw new InviteError(409, 'already_invited', `${email} already has a pending invitation. Revoke it first to send a new link.`);
    }
    // The old one expired (or was half-removed): replace it.
    if (existing) await drop(kv, existing);
    if (!(await kv.setIfAbsent(index, id))) throw new InviteError(409, 'already_invited', `${email} was invited a moment ago.`);
  }

  const token = randomBytes(32).toString('base64url');
  const invite: StoredInvite = {
    id, email, invitedBy: input.invitedBy, createdAt: now, expiresAt: now + INVITE_DAYS * DAY,
    workspaceId: input.workspaceId, tokenHash: hashToken(token),
  };
  await kv.set(inviteKey(input.workspaceId, id), invite);
  await kv.set(tokenKey(invite.tokenHash), { workspaceId: input.workspaceId, inviteId: id });
  return { invite, token };
}

export async function revokeInvite(kv: KV, workspaceId: string, id: string): Promise<void> {
  const invite = /^[0-9a-f-]{36}$/.test(id) ? await kv.get<StoredInvite>(inviteKey(workspaceId, id)) : null;
  if (!invite) throw new InviteError(404, 'not_found', 'That invitation no longer exists.');
  await drop(kv, invite);
}

/** The invitation a link's token stands for, or an InviteError saying why it cannot be used. */
export async function findInvite(kv: KV, token: unknown, now = Date.now()): Promise<StoredInvite> {
  const invalid = () => new InviteError(404, 'invalid_invite', 'This invitation link is not valid. It may have been revoked or already used; ask for a new one.');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw invalid();
  const hash = hashToken(token);
  const ref = await kv.get<{ workspaceId: string; inviteId: string }>(tokenKey(hash));
  const invite = ref ? await kv.get<StoredInvite>(inviteKey(ref.workspaceId, ref.inviteId)) : null;
  if (!invite || invite.tokenHash !== hash) throw invalid();
  if (invite.expiresAt <= now) throw new InviteError(410, 'invite_expired', 'This invitation has expired. Ask the person who invited you for a new link.');
  return invite;
}

/**
 * Use an invitation exactly once: claim it, run `join` (which creates the
 * account), then remove it. If `join` fails the claim is released so the
 * person can correct the form and try again.
 */
export async function acceptInvite<T>(kv: KV, token: unknown, join: (invite: StoredInvite) => Promise<T>, now = Date.now()): Promise<T> {
  const invite = await findInvite(kv, token, now);
  if (!(await kv.setIfAbsent(claimKey(invite.tokenHash), now))) {
    throw new InviteError(409, 'invite_used', 'This invitation is being used right now. If that was you, sign in instead.');
  }
  let result: T;
  try {
    result = await join(invite);
  } catch (err) {
    await kv.delete(claimKey(invite.tokenHash));
    throw err;
  }
  await drop(kv, invite);
  await kv.delete(claimKey(invite.tokenHash));
  return result;
}
