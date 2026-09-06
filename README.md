# Agentify

Marketing site for Agentify, the AI-powered Shopify build team. Built with
[Astro](https://astro.build): every page is pre-rendered to static HTML at
build time, so search engines receive complete, crawlable documents without
executing JavaScript. A small client script animates the Live board after load.

## Pages

| Route      | Source                     | Status                                  |
| ---------- | -------------------------- | --------------------------------------- |
| `/live`    | `src/pages/live.astro`     | Implemented from `Live.dc.html`         |
| `/`        | `src/pages/index.astro`    | Implemented from `Agentify Console.dc.html` |
| `/team`    | `src/pages/team.astro`     | Implemented from `Team.dc.html`         |
| `/process` | `src/pages/process.astro`  | Implemented from `Process.dc.html`      |
| `/pricing` | `src/pages/pricing.astro`  | Implemented from `Pricing.dc.html`      |
| `/contact` | `src/pages/contact.astro`  | Implemented from `Contact.dc.html`      |

Every page is indexable and listed in the sitemap. To keep a future page out
of the sitemap, add its path to `PLACEHOLDER_ROUTES` in `astro.config.mjs` and
pass `noindex` to the Base layout.

Shared building blocks: `src/layouts/Base.astro` (SEO head, header, footer),
`src/components/PageHero.astro` and `PageCta.astro` (used by Team, Process,
Pricing and Contact), page data in `src/data/`, page sections in
`src/components/<page>/`, one client script per page in `src/scripts/`.

## SEO checklist (per page, via `src/layouts/Base.astro`)

- Unique `<title>` and meta description, `lang="en-GB"`, viewport, theme-color
- Canonical URL, `robots` directives, Open Graph + Twitter cards, OG image
- JSON-LD graph: Organization, WebSite, WebPage, plus per-page BreadcrumbList
- Semantic landmarks (`header`, `nav`, `main`, `footer`), one `h1`, ordered headings
- Real `<table>` for the ticket queue, lists for lanes and the feed, `<time>` elements
- `sitemap-index.xml` and `robots.txt` generated at build time
- Responsive layout with no horizontal page scroll; reduced-motion respected

## Intake form

`/contact` is a real three-step `<form>` (fields: `store`, `email`, `problem`,
`band`, `roles[]`). No backend is wired yet: submission shows the confirmation
locally. To post the intake somewhere, set `data-endpoint="https://…"` on the
form in `src/components/contact/IntakeForm.astro`; the script POSTs the answers
as JSON.

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
