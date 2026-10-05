/**
 * Accounts and sessions. Passwords are hashed with scrypt; the session is a
 * signed, HttpOnly cookie holding the user id and an expiry, so no session
 * table is needed. SESSION_SECRET must be set in production.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { AstroCookies } from 'astro';
import type { User, Workspace } from '../agency/types';
import { getStore } from './storage';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const COOKIE = 'agentify_session';
const SESSION_DAYS = 30;

interface StoredUser extends User {
  passwordHash: string;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const env = (name: string): string | undefined => process.env[name] ?? (import.meta.env?.[name] as string | undefined);

function secret(): Buffer {
  const value = env('SESSION_SECRET');
  if (value && value.length >= 16) return Buffer.from(value);
  if (env('VERCEL') || import.meta.env?.PROD) {
    throw new HttpError(500, 'not_configured', 'SESSION_SECRET is not set (16+ characters).');
  }
  // Development only: a fixed key so sessions survive restarts.
  return Buffer.from('agentify-development-secret-do-not-deploy');
}

/* ── passwords ─────────────────────────────────────────────────────── */

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

/* ── session cookie ────────────────────────────────────────────────── */

const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url');

function setSession(cookies: AstroCookies, userId: string) {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `${userId}.${expires}`;
  cookies.set(COOKIE, `${payload}.${sign(payload)}`, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: !!(env('VERCEL') || import.meta.env?.PROD),
    expires: new Date(expires),
  });
}

export function clearSession(cookies: AstroCookies) {
  cookies.delete(COOKIE, { path: '/' });
}

function sessionUserId(cookies: AstroCookies): string | null {
  const raw = cookies.get(COOKIE)?.value;
  if (!raw) return null;
  const [userId, expires, mac] = raw.split('.');
  if (!userId || !expires || !mac) return null;
  const expected = Buffer.from(sign(`${userId}.${expires}`));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return Number(expires) > Date.now() ? userId : null;
}

/* ── accounts ──────────────────────────────────────────────────────── */

const emailKey = (email: string) => `email:${email}`;
const userKey = (id: string) => `user:${id}`;
export const workspaceKey = (id: string) => `ws:${id}`;
/** One key per member, so a workspace's members can be listed by prefix. */
export const memberKey = (workspaceId: string, userId: string) => `member:${workspaceId}:${userId}`;

const publicUser = ({ passwordHash: _hash, ...user }: StoredUser): User => user;

const normalEmail = (email: unknown) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

export interface SignupInput {
  email: unknown;
  password: unknown;
  name: unknown;
  workspaceName: unknown;
  /** Set by the invitation flow: join this workspace as a member instead of creating one. */
  join?: { workspaceId: string };
}

export const TRIAL_DAYS = 14;

export async function signup(cookies: AstroCookies, input: SignupInput): Promise<{ user: User; workspace: Workspace }> {
  const email = normalEmail(input.email);
  const password = typeof input.password === 'string' ? input.password : '';
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
  const workspaceName = typeof input.workspaceName === 'string' ? input.workspaceName.trim().slice(0, 80) : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
  if (password.length < 8 || password.length > 200) throw new HttpError(400, 'weak_password', 'Use a password of at least 8 characters.');
  if (!name) throw new HttpError(400, 'invalid_name', 'Enter your name.');

  const store = getStore();
  const now = Date.now();
  const user: StoredUser = {
    id: randomUUID(), email, name, workspaceId: input.join?.workspaceId ?? randomUUID(),
    role: input.join ? 'member' : 'owner', notify: true, createdAt: now,
    passwordHash: await hashPassword(password),
  };
  // The email index is the uniqueness check: only one signup can claim it.
  if (!(await store.setIfAbsent(emailKey(email), user.id))) {
    throw new HttpError(409, 'email_taken', 'An account with this email already exists. Sign in instead.');
  }
  let workspace: Workspace;
  if (input.join) {
    // Joining through an invitation: the workspace already exists.
    const existing = await store.get<Workspace>(workspaceKey(input.join.workspaceId));
    if (!existing) throw new HttpError(404, 'not_found', 'That workspace no longer exists.');
    workspace = existing;
  } else {
    workspace = {
      id: user.workspaceId, name: workspaceName || `${name}'s workspace`, notes: '', stores: [], github: null,
      plan: { tier: 'trial', status: 'trialing', periodStart: now, periodEnd: now + TRIAL_DAYS * 86_400_000 },
      taskSeq: 0, createdAt: now,
    };
    await store.set(workspaceKey(workspace.id), workspace);
  }
  await store.set(userKey(user.id), user);
  await store.set(memberKey(workspace.id, user.id), user.id);
  setSession(cookies, user.id);
  return { user: publicUser(user), workspace };
}

export async function login(cookies: AstroCookies, input: { email: unknown; password: unknown }): Promise<User> {
  const store = getStore();
  const email = normalEmail(input.email);
  const password = typeof input.password === 'string' ? input.password : '';
  const userId = email ? await store.get<string>(emailKey(email)) : null;
  const user = userId ? await store.get<StoredUser>(userKey(userId)) : null;
  // Same message either way, so the form does not reveal which emails exist.
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new HttpError(401, 'bad_credentials', 'Email or password is incorrect.');
  }
  setSession(cookies, user.id);
  return publicUser(user);
}

/** The signed-in user and their workspace, or a 401. */
export async function requireSession(cookies: AstroCookies): Promise<{ user: User; workspace: Workspace }> {
  const userId = sessionUserId(cookies);
  const store = getStore();
  const user = userId ? await store.get<StoredUser>(userKey(userId)) : null;
  const workspace = user ? await store.get<Workspace>(workspaceKey(user.workspaceId)) : null;
  if (!user || !workspace) throw new HttpError(401, 'unauthorized', 'Sign in to continue.');
  user.role ??= 'owner';
  user.notify ??= true;
  return { user: publicUser(user), workspace: normaliseWorkspace(workspace) };
}

/** Fill in fields added after a workspace was stored (stores, GitHub, plan). */
export function normaliseWorkspace(workspace: Workspace): Workspace {
  workspace.stores ??= [];
  workspace.github ??= null;
  workspace.plan ??= {
    tier: 'trial', status: 'trialing',
    periodStart: workspace.createdAt, periodEnd: workspace.createdAt + TRIAL_DAYS * 86_400_000,
  };
  return workspace;
}

/** Owner-only actions: billing, members, connections. */
export function requireOwner(user: User): void {
  if (user.role !== 'owner') throw new HttpError(403, 'owner_only', 'Only the workspace owner can do that.');
}

/** Everyone in a workspace. */
export async function listMembers(workspaceId: string): Promise<User[]> {
  const store = getStore();
  const ids = await store.getMany<string>(await store.keys(`member:${workspaceId}:`));
  const users = await store.getMany<StoredUser>(ids.filter((id): id is string => !!id).map(userKey));
  return users.filter((u): u is StoredUser => !!u).map(publicUser).sort((a, b) => a.createdAt - b.createdAt);
}

export async function updateUser(userId: string, patch: Partial<Pick<User, 'name' | 'notify'>>): Promise<User> {
  const store = getStore();
  const user = await store.get<StoredUser>(userKey(userId));
  if (!user) throw new HttpError(404, 'not_found', 'That user does not exist.');
  Object.assign(user, patch);
  await store.set(userKey(userId), user);
  return publicUser(user);
}

/** Remove a member's account from a workspace. */
export async function removeMember(workspaceId: string, userId: string): Promise<void> {
  const store = getStore();
  const user = await store.get<StoredUser>(userKey(userId));
  if (!user || user.workspaceId !== workspaceId) throw new HttpError(404, 'not_found', 'That member does not exist.');
  if (user.role === 'owner') throw new HttpError(409, 'owner', 'The owner cannot be removed.');
  await store.delete(memberKey(workspaceId, userId));
  await store.delete(userKey(userId));
  await store.delete(emailKey(user.email));
}

/** HMAC over a string with the server secret, for signed state and internal calls. */
export const signValue = (value: string): string => sign(value);

export function verifyValue(value: string, mac: string): boolean {
  const expected = Buffer.from(sign(value));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/* ── secrets at rest (the Shopify access token) ────────────────────── */

const cipherKey = () => createHmac('sha256', secret()).update('agentify:secrets:v1').digest();

/** AES-256-GCM, as "iv.tag.ciphertext" in base64url. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cipherKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(sealed: string): string {
  const [iv, tag, data] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !data) throw new Error('Malformed secret.');
  const decipher = createDecipheriv('aes-256-gcm', cipherKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
