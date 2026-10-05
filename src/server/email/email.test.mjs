/**
 * Email content, escaping, the Resend request, and "needs you" dedupe.
 *
 *   node --experimental-strip-types --test src/server/email/email.test.mjs
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { memoryStore } from '../testing/memory-store.mjs';
import { escapeHtml, invitationEmail, needOf, needsYouEmail } from './messages.ts';
import { notifyWaiting } from './needs-you.ts';
import { sendEmail } from './resend.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const EVIL = `<script>alert("x")</script> & 'q'`;

const task = (over = {}) => ({
  id: 't-1', number: 12, workspaceId: 'ws-1', storeId: null, title: 'Size guide', priority: 'normal', phase: 'discovery', waiting: 'client', paused: false,
  messages: [
    { id: 'm1', at: 1, from: 'client', to: 'atlas', kind: 'chat', text: 'Add a size guide' },
    { id: 'm2', at: 2, from: 'atlas', to: 'client', kind: 'chat', text: 'Which products need it?' },
  ],
  brief: null, feasibility: null, spec: null, build: null, review: null, deploy: null, pullRequest: null,
  usage: { input: 0, output: 0 }, lockedUntil: 0, archived: false, createdAt: 1, updatedAt: 2, ...over,
});

test('escapeHtml', () => {
  assert.equal(escapeHtml(EVIL), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;');
});

test('invitation: user strings escaped in HTML, subject on one line', () => {
  const e = invitationEmail({ inviter: `${EVIL}\nBcc: x@y.z`, workspace: EVIL, link: 'https://a.test/dashboard/join/tok"en', expiresAt: Date.UTC(2026, 9, 8) });
  assert.ok(!e.html.includes('<script>'));
  assert.ok(e.html.includes('&lt;script&gt;'));
  assert.ok(e.html.includes('href="https://a.test/dashboard/join/tok&quot;en"'));
  assert.ok(!/[\r\n]/.test(e.subject));
  assert.match(e.text, /Accept the invitation: https:\/\/a\.test/);
  assert.match(e.text, /expires on Thursday, October 8/);
});

test('needs you: question (with the trimmed text), approval, failure', () => {
  const link = 'https://a.test/dashboard/t/t-1', settingsLink = 'https://a.test/dashboard/settings#members';
  const long = `${EVIL} ${'word '.repeat(400)}`;
  const q = needsYouEmail({ task: task({ title: EVIL, messages: [{ id: 'm2', at: 2, from: 'atlas', to: 'client', kind: 'chat', text: long }] }), workspace: 'Northwind', link, settingsLink });
  assert.match(q.subject, /^#12 .*: Atlas has a question$/);
  assert.ok(!q.html.includes('<script>'));
  assert.ok(q.text.length < 1200, 'question is trimmed');
  assert.match(q.text, /…/);
  assert.match(q.text, new RegExp(`Answer in the thread: ${link}`));

  const gate = needsYouEmail({ task: task({ phase: 'gate', waiting: 'gate', messages: [{ id: 'm9', at: 9, from: 'sieve', to: 'team', kind: 'review', text: 'All criteria pass.' }] }), workspace: 'N', link, settingsLink });
  assert.equal(gate.subject, '#12 Size guide is ready for your approval');
  assert.ok(!gate.text.includes('All criteria pass'), 'approval mail does not quote the review');

  const failed = task({ messages: [{ id: 'm3', at: 3, from: 'system', to: 'client', kind: 'error', text: 'Volt timed out.' }] });
  assert.equal(needOf(failed).kind, 'failed');
  assert.match(needsYouEmail({ task: failed, workspace: 'N', link, settingsLink }).subject, /a step failed/);
});

test('sendEmail: Resend request shape and errors', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); };
  const id = await sendEmail({ apiKey: 're_x', from: 'Agentify <team@a.test>' }, 'sam@shop.com', { subject: 's', text: 't', html: 'h' }, 'invite/1');
  assert.equal(id, 'em_1');
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_x');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'invite/1');
  assert.ok(calls[0].init.headers['User-Agent']);
  assert.deepEqual(JSON.parse(calls[0].init.body), { from: 'Agentify <team@a.test>', to: ['sam@shop.com'], subject: 's', text: 't', html: 'h' });
  globalThis.fetch = async () => new Response(JSON.stringify({ statusCode: 422, name: 'validation_error', message: 'bad from' }), { status: 422 });
  await assert.rejects(sendEmail({ apiKey: 're_x', from: 'x' }, 'a@b.c', { subject: 's', text: 't', html: 'h' }), /bad from/);
});

const members = [
  { id: 'u1', email: 'owner@shop.com', name: 'Ada', workspaceId: 'ws-1', role: 'owner', notify: true, createdAt: 1 },
  { id: 'u2', email: 'quiet@shop.com', name: 'Bo', workspaceId: 'ws-1', role: 'member', notify: false, createdAt: 2 },
  { id: 'u3', email: 'sam@shop.com', name: 'Sam', workspaceId: 'ws-1', role: 'member', notify: true, createdAt: 3 },
];
const ws = { id: 'ws-1', name: 'Northwind' };

test('notifyWaiting: only members with notify on, once per waiting state, never throws', async () => {
  const kv = memoryStore();
  const sent = [];
  const deps = { kv, members: async () => members, send: async (to, email, key) => { sent.push({ to, subject: email.subject, key }); } };
  // Two steps finishing together on the same state: one email per person.
  const counts = await Promise.all([notifyWaiting(deps, ws, task(), 'https://a.test'), notifyWaiting(deps, ws, task(), 'https://a.test')]);
  assert.deepEqual(counts.sort(), [0, 2]);
  assert.deepEqual(sent.map((s) => s.to).sort(), ['owner@shop.com', 'sam@shop.com']);
  assert.equal(await notifyWaiting(deps, ws, task(), 'https://a.test'), 0, 'same state again');
  // A new question is a new state.
  const next = task({ messages: [...task().messages, { id: 'm4', at: 4, from: 'atlas', to: 'client', kind: 'chat', text: 'And colours?' }] });
  assert.equal(await notifyWaiting(deps, ws, next, 'https://a.test'), 2);
  // Not waiting on a person, or archived: nothing.
  assert.equal(await notifyWaiting(deps, ws, task({ id: 't-2', waiting: 'agents' }), 'https://a.test'), 0);
  assert.equal(await notifyWaiting(deps, ws, task({ id: 't-3', archived: true }), 'https://a.test'), 0);

  // Provider down: nobody gets it, nothing throws, and the claim is released for a later try.
  const failing = { kv, members: async () => members, send: async () => { throw new Error('503'); } };
  const t5 = task({ id: 't-5' });
  assert.equal(await notifyWaiting(failing, ws, t5, 'https://a.test'), 0);
  assert.equal(await notifyWaiting(deps, ws, t5, 'https://a.test'), 2);
  // Even a broken member lookup does not throw.
  assert.equal(await notifyWaiting({ kv, members: async () => { throw new Error('db'); }, send: async () => {} }, ws, task({ id: 't-6' }), 'x'), 0);
});
