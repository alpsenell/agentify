/**
 * Site-wide constants. The production origin comes from PUBLIC_SITE_URL
 * (see astro.config.mjs / .env.example) and is exposed as Astro.site.
 */
export const SITE = {
  name: 'Agentify',
  tagline: 'Shopify build team',
  description:
    'Agentify is an AI-powered Shopify build team: an orchestrated crew of agents that scopes, writes, builds, tests and ships store changes behind a human gate.',
  lang: 'en-GB',
  locale: 'en_GB',
  themeColor: '#f5f2ec',
} as const;

export interface NavItem {
  href: string;
  label: string;
}

export const NAV: readonly NavItem[] = [
  { href: '/', label: 'Console' },
  { href: '/team', label: 'Team' },
  { href: '/process', label: 'Process' },
  { href: '/live', label: 'Live' },
  { href: '/pricing', label: 'Pricing' },
];

