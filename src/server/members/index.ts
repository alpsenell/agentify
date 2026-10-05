/**
 * Members and invitations, wired to sessions, accounts, the plan's seat
 * limit and email. The invitation logic itself is in invites.ts.
 */
import type { AstroCookies } from 'astro';
import type { Invite, User, Workspace } from '../../agency/types';
import { HttpError, listMembers, removeMember, signup } from '../auth';
import { assertSeatFree } from '../billing';
import { sendInvitation } from '../notify';
import { getWorkspace } from '../repo';
import { getStore } from '../storage';
import { InviteError, acceptInvite, createInvite, findInvite, listInvites, publicInvite, revokeInvite } from './invites';

const toHttp = (err: unknown): never => {
  if (err instanceof InviteError) throw new HttpError(err.status, err.code, err.message);
  throw err;
};

/** auth.ts keeps one `email:<address>` key per account; its presence means the address is taken. */
const accountExists = async (email: string) => (await getStore().get<string>(`email:${email}`)) !== null;

export const joinLink = (origin: string, token: string) => `${origin}/dashboard/join/${token}`;

export async function membersOf(workspaceId: string): Promise<{ members: User[]; invites: Invite[] }> {
  const [members, invites] = await Promise.all([listMembers(workspaceId), listInvites(getStore(), workspaceId)]);
  return { members, invites: invites.map(publicInvite) };
}

export async function invite(inviter: User, workspace: Workspace, email: unknown, origin: string): Promise<{ invite: Invite; link: string; emailed: boolean }> {
  const { invite: created, token } = await createInvite(getStore(), {
    workspaceId: workspace.id, email, invitedBy: inviter.name, accountExists,
    beforeCreate: async () => {
      const { members, invites } = await membersOf(workspace.id);
      assertSeatFree(workspace, members.length + invites.length);
    },
  }).catch(toHttp);
  const link = joinLink(origin, token);
  const emailed = await sendInvitation({
    to: created.email, inviter: inviter.name, workspace: workspace.name, link, expiresAt: created.expiresAt, inviteId: created.id,
  });
  return { invite: publicInvite(created), link, emailed };
}

export async function revoke(workspaceId: string, inviteId: string): Promise<void> {
  await revokeInvite(getStore(), workspaceId, inviteId).catch(toHttp);
}

export async function remove(owner: User, userId: string): Promise<void> {
  if (userId === owner.id) throw new HttpError(409, 'self', 'You cannot remove yourself from your own workspace.');
  await removeMember(owner.workspaceId, userId);
}

/** What an invitation link is for, for the join screen. */
export async function inviteInfo(token: unknown): Promise<{ email: string; workspaceName: string; invitedBy: string }> {
  const found = await findInvite(getStore(), token).catch(toHttp);
  const workspace = await getWorkspace(found.workspaceId);
  if (!workspace) throw new HttpError(404, 'invalid_invite', 'The workspace this invitation was for no longer exists.');
  return { email: found.email, workspaceName: workspace.name, invitedBy: found.invitedBy };
}

/** Create the invited person's account in the workspace, sign them in, and use up the invitation. */
export async function accept(cookies: AstroCookies, input: { token: unknown; name: unknown; password: unknown }): Promise<{ user: User; workspace: Workspace }> {
  return acceptInvite(getStore(), input.token, (found) =>
    signup(cookies, { email: found.email, password: input.password, name: input.name, workspaceName: '', join: { workspaceId: found.workspaceId } }),
  ).catch(toHttp);
}
