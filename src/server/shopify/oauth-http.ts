/** What the two OAuth routes share: the nonce cookie and the redirect back to Settings. */
const env = (name: string): string | undefined => process.env[name] ?? (import.meta.env?.[name] as string | undefined);

export const OAUTH_COOKIE = 'agentify_shopify_oauth';

/** Lax so it rides along on Shopify's top-level redirect back to us; scoped to the OAuth routes. */
export const oauthCookieOptions = () => ({
  path: '/api/shopify/oauth', httpOnly: true, sameSite: 'lax' as const, secure: !!(env('VERCEL') || import.meta.env?.PROD), maxAge: 600,
});

/** 303 to the stores section of Settings with the result flags the app turns into a toast. */
export function settingsRedirect(flags: Record<string, string>, path = '/dashboard/settings'): Response {
  const query = new URLSearchParams(Object.entries(flags).filter(([, v]) => v)).toString();
  return new Response(null, {
    status: 303,
    headers: { Location: `${path}${query ? `?${query}` : ''}${path.endsWith('/settings') ? '#stores' : ''}`, 'Cache-Control': 'no-store' },
  });
}
