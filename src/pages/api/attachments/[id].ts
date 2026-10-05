/** GET /api/attachments/:id — the bytes of an attachment, to members of the workspace that owns it. */
import type { APIRoute } from 'astro';
import { loadAttachment, serveHeaders } from '../../../server/attachments';
import { requireSession } from '../../../server/auth';
import { handle } from '../../../server/http';

export const prerender = false;

export const GET: APIRoute = ({ params, cookies }) =>
  handle(async () => {
    const { workspace } = await requireSession(cookies);
    const { attachment, bytes } = await loadAttachment(workspace.id, params.id ?? '');
    // Bytes from Buffer.concat sit on a plain ArrayBuffer.
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: serveHeaders(attachment) });
  });
