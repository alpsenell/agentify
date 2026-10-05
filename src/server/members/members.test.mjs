/**
 * The invitation lifecycle against an in-memory store.
 *
 *   node --experimental-strip-types --test src/server/members/members.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryStore } from '../testing/memory-store.mjs';
import { INVITE_DAYS, acceptInvite, createInvite, findInvite, hashToken, listInvites, revokeInvite } from './invites.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);
const none = async () => false;
const make = (kv, email, over = {}) => createInvite(kv, { workspaceId: 'ws-1', email, invitedBy: 'Ada', accountExists: none, now: T0, ...over });

test('create: normalised email, 7-day expiry, only the token hash is stored', async () => {
  const kv = memoryStore();
  const { invite, token } = await make(kv, '  Sam@Shop.COM ');
  assert.equal(invite.email, 'sam@shop.com');
  assert.equal(invite.expiresAt - invite.createdAt, INVITE_DAYS * DAY);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const stored = JSON.stringify([...kv.data.entries()]);
  assert.ok(!stored.includes(token), 'raw token is never stored');
  assert.ok(stored.includes(hashToken(token)));
  assert.deepEqual((await listInvites(kv, 'ws-1', T0)).map((i) => i.email), ['sam@shop.com']);
});

test('create: refuses bad emails, existing accounts and a second pending invite', async () => {
  const kv = memoryStore();
  await assert.rejects(make(kv, 'not-an-email'), { code: 'invalid_email' });
  await assert.rejects(make(kv, 'taken@shop.com', { accountExists: async () => true }), (e) => e.code === 'email_taken' && /already has an Agentify account/.test(e.message));
  await make(kv, 'sam@shop.com');
  await assert.rejects(make(kv, 'SAM@shop.com'), { code: 'already_invited' });
  // Two owners clicking at once: exactly one wins.
  const results = await Promise.allSettled([make(kv, 'kim@shop.com'), make(kv, 'kim@shop.com'), make(kv, 'kim@shop.com')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  // Other workspaces are independent.
  await make(kv, 'sam@shop.com', { workspaceId: 'ws-2' });
});

test('expired: the link says so, it drops off the list, and the email can be invited again', async () => {
  const kv = memoryStore();
  const { token } = await make(kv, 'sam@shop.com');
  const later = T0 + 8 * DAY;
  await assert.rejects(findInvite(kv, token, later), { code: 'invite_expired', status: 410 });
  await assert.rejects(acceptInvite(kv, token, async () => 'joined', later), { code: 'invite_expired' });
  assert.deepEqual(await make(kv, 'sam@shop.com', { now: later }).then((r) => r.invite.email), 'sam@shop.com');
  assert.equal((await listInvites(kv, 'ws-1', later)).length, 1);
  await assert.rejects(findInvite(kv, token, later), { code: 'invalid_invite' }, 'the old link is gone');
});

test('accept: runs join once, consumes the invite; a failed join leaves it usable', async () => {
  const kv = memoryStore();
  const { invite, token } = await make(kv, 'sam@shop.com');
  await assert.rejects(acceptInvite(kv, token, async () => { throw Object.assign(new Error('weak'), { code: 'weak_password' }); }, T0), { code: 'weak_password' });
  let joins = 0;
  const join = async (found) => { joins++; assert.equal(found.id, invite.id); await new Promise((r) => setTimeout(r, 5)); return 'joined'; };
  const both = await Promise.allSettled([acceptInvite(kv, token, join, T0), acceptInvite(kv, token, join, T0)]);
  assert.equal(joins, 1);
  assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  await assert.rejects(findInvite(kv, token, T0), { code: 'invalid_invite' });
  assert.equal((await listInvites(kv, 'ws-1', T0)).length, 0);
  assert.equal([...kv.data.keys()].filter((k) => k.startsWith('invite')).length, 0, 'nothing left behind');
});

test('revoke: the link stops working; garbage tokens and ids are refused', async () => {
  const kv = memoryStore();
  const { invite, token } = await make(kv, 'sam@shop.com');
  await assert.rejects(revokeInvite(kv, 'ws-2', invite.id), { code: 'not_found' }, 'another workspace cannot revoke it');
  await revokeInvite(kv, 'ws-1', invite.id);
  await assert.rejects(findInvite(kv, token, T0), { code: 'invalid_invite' });
  await assert.rejects(revokeInvite(kv, 'ws-1', invite.id), { code: 'not_found' });
  for (const bad of [undefined, '', 'short', '../../etc', 'x'.repeat(200)]) await assert.rejects(findInvite(kv, bad, T0), { code: 'invalid_invite' });
  await make(kv, 'sam@shop.com'); // can be invited again
});

test('the seat check runs after validation, so a duplicate says "already invited", and a refusal writes nothing', async () => {
  const kv = memoryStore();
  await make(kv, 'sam@shop.com');
  const full = () => { throw Object.assign(new Error('seats'), { code: 'plan_limit' }); };
  await assert.rejects(make(kv, 'sam@shop.com', { beforeCreate: full }), { code: 'already_invited' });
  await assert.rejects(make(kv, 'bad', { beforeCreate: full }), { code: 'invalid_email' });
  const before = kv.data.size;
  await assert.rejects(make(kv, 'kim@shop.com', { beforeCreate: full }), { code: 'plan_limit' });
  assert.equal(kv.data.size, before);
});
