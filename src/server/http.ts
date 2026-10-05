/** Small helpers shared by the API routes: JSON responses, error mapping, body parsing. */
import type { ApiError } from '../agency/types';
import { HttpError } from './auth';

export function json(data: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function errorBody(err: unknown): { status: number; body: ApiError } {
  if (err instanceof HttpError) return { status: err.status, body: { error: err.message, code: err.code } };
  console.error(err);
  return { status: 500, body: { error: 'Something went wrong on the server.', code: 'server_error' } };
}

/** Run a route body, turning thrown HttpErrors (and anything else) into JSON error responses. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    const { status, body } = errorBody(err);
    return json(body, status);
  }
}

/** The request body as an object, or a 400. */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'bad_request', 'Send a JSON object.');
  }
  return body as Record<string, unknown>;
}

/**
 * Refuse cross-site writes: a state-changing request must come from our own
 * origin. The session cookie is SameSite=Lax, so this is a second check.
 */
export function sameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new HttpError(403, 'forbidden', 'Cross-site request refused.');
  }
}
