/** POST /api/attachments — upload one file (multipart, field "file"); attach it to a message by id. */
import type { APIRoute } from 'astro';
import { MAX_IMAGE_BYTES, saveAttachment } from '../../../server/attachments';
import { HttpError, requireSession } from '../../../server/auth';
import { handle, json, sameOrigin } from '../../../server/http';

export const prerender = false;

/** Room for the multipart envelope around the largest allowed file. */
const MAX_BODY = MAX_IMAGE_BYTES + 64 * 1024;

export const POST: APIRoute = ({ request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { workspace } = await requireSession(cookies);
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > MAX_BODY) throw new HttpError(413, 'too_large', 'That file is too large to upload.');
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!file || typeof file === 'string') throw new HttpError(400, 'bad_request', 'Send the file as multipart form data in the field "file".');
    if (file.size > MAX_BODY) throw new HttpError(413, 'too_large', 'That file is too large to upload.');
    const attachment = await saveAttachment(workspace.id, {
      name: file.name,
      type: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return json(attachment, 201);
  });
