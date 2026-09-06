# Agentify

Marketing site for Agentify, the AI-powered Shopify build team. Built with
[Astro](https://astro.build): every page is pre-rendered to static HTML at
build time, so search engines receive complete, crawlable documents without
executing JavaScript. A small client script animates the Live board after load.

## Pages

| Route      | Source                     | Status                                  |
| ---------- | -------------------------- | --------------------------------------- |
| `/live`    | `src/pages/live.astro`     | Implemented from `Live.dc.html`         |
| `/`        | `src/pages/index.astro`    | Placeholder (noindex) — Console design  |
| `/team`    | `src/pages/team.astro`     | Placeholder (noindex)                   |
| `/process` | `src/pages/process.astro`  | Placeholder (noindex)                   |
| `/pricing` | `src/pages/pricing.astro`  | Placeholder (noindex)                   |
| `/contact` | `src/pages/contact.astro`  | Placeholder (noindex)                   |

Placeholders exist only so internal links resolve. They carry
`noindex, nofollow` and are excluded from the sitemap (see `PLACEHOLDER_ROUTES`
in `astro.config.mjs`). Replace each with its design and remove it from that set.

## SEO checklist (per page, via `src/layouts/Base.astro`)

- Unique `<title>` and meta description, `lang="en-GB"`, viewport, theme-color
- Canonical URL, `robots` directives, Open Graph + Twitter cards, OG image
- JSON-LD graph: Organization, WebSite, WebPage, plus per-page BreadcrumbList
- Semantic landmarks (`header`, `nav`, `main`, `footer`), one `h1`, ordered headings
- Real `<table>` for the ticket queue, lists for lanes and the feed, `<time>` elements
- `sitemap-index.xml` and `robots.txt` generated at build time
- Responsive layout with no horizontal page scroll; reduced-motion respected

## Configuration

Set the production origin before building — it drives canonical/OG URLs,
`sitemap.xml` and `robots.txt`:

```sh
cp .env.example .env   # then edit PUBLIC_SITE_URL
```

## Commands

```sh
npm install
npm run dev      # http://localhost:4321
npm run build    # static output in dist/
npm run preview  # serve dist/
npm run check    # type-check .astro/.ts
```

`build.format` is `file`, so `/live` is emitted as `dist/live.html`; static
hosts (Netlify, Vercel, Cloudflare Pages) serve it at the clean URL.
