// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import vercel from '@astrojs/vercel';

// Set PUBLIC_SITE_URL in the environment (or .env) to the production origin.
// It drives canonical URLs, Open Graph URLs, sitemap.xml and robots.txt.
const site = process.env.PUBLIC_SITE_URL || 'https://agentify.plus';
// Routes to keep out of the sitemap (none at present; add paths here for noindex pages).
/** @type {Set<string>} */
const PLACEHOLDER_ROUTES = new Set();

export default defineConfig({
  site,
  trailingSlash: 'never',
  build: { format: 'file' },
  // Marketing pages are pre-rendered; the app (/dashboard) and /api run on demand.
  output: 'static',
  adapter: vercel({ maxDuration: 300 }),
  compressHTML: true,
  integrations: [
    react(),
    sitemap({
      // The operator panel (/dashboard/*) is an app behind noindex, not content.
      filter: (page) => {
        const path = new URL(page).pathname.replace(/\/$/, '') || '/';
        return !PLACEHOLDER_ROUTES.has(path) && !path.startsWith('/dashboard');
      },
      changefreq: 'hourly',
      priority: 0.8,
    }),
  ],
});
