/**
 * POST /api/internal/step — run one agent step. Called only by the server
 * itself (runner.ts kick), with a signed body. It answers at once and does
 * the work after the response, so the caller is never kept waiting.
 */
import type { APIRoute } from 'astro';
import { handle, json, readBody } from '../../../server/http';
import { background, runOne, verifyKick } from '../../../server/runner';

export const prerender = false;

export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    const { workspaceId, taskId } = verifyKick(await readBody(request));
    background(runOne(new URL(request.url).origin, workspaceId, taskId));
    return json({ accepted: true }, 202);
  });
