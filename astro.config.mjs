// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Set PUBLIC_SITE_URL in the environment (or .env) to the production origin.
// It drives canonical URLs, Open Graph URLs, sitemap.xml and robots.txt.
const site = process.env.PUBLIC_SITE_URL || 'https://agentify.example.com';
const PLACEHOLDER_ROUTES = new Set(['/', '/team', '/process', '/pricing', '/contact']);

export default defineConfig({
  site,
  trailingSlash: 'never',
  build: { format: 'file' },
  output: 'static',
  compressHTML: true,
  integrations: [
    sitemap({
      // Placeholder pages (see src/config/site.ts PLACEHOLDER_ROUTES) are
      // noindex and are excluded from the sitemap.
      filter: (page) => !PLACEHOLDER_ROUTES.has(new URL(page).pathname.replace(/\/$/, '') || '/'),
      changefreq: 'hourly',
      priority: 0.8,
    }),
  ],
});
