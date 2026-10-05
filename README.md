# Agentify

Agentify, the AI-powered Shopify build team: the marketing site and the app
clients use to work with the agents. Built with [Astro](https://astro.build).
Every marketing page is pre-rendered to static HTML at build time, so search
engines receive complete, crawlable documents without executing JavaScript.
The app under `/dashboard` and its API run on the server.

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

## The app (`/dashboard`)

Where a client works with the team. They sign in, describe what they need in
a thread, and the agents hand the request to each other:

| Phase       | Agent  | What happens                                                        |
| ----------- | ------ | ------------------------------------------------------------------- |
| Discovery   | Atlas  | Talks with the client, writes the brief and acceptance criteria     |
| Feasibility | Forge  | Checks it against Shopify and the store: blockers, edge cases       |
| Design      | Muse   | UI/UX spec: layout, states, responsive, accessibility, copy         |
| Build       | Volt   | Writes the theme files (Liquid, CSS, JS)                            |
| Review      | Sieve  | Checks every acceptance criterion; a fail goes back to Volt         |
| Gate        | Client | Approves, or returns it with a reason                               |
| Ship        | Relay  | Deploys to an unpublished preview theme (never the live theme)      |

Layout:

- `src/agency/types.ts`: the shapes shared by server and app.
- `src/server/`: accounts and sessions (`auth.ts`), storage (`storage.ts`),
  tasks (`repo.ts`, `tasks.ts`), the agents (`agents/`: hand-off rules in
  `flow.ts`, prompts in `prompts.ts`, the Claude call in `llm.ts`, one step in
  `run.ts`) and the store connection (`shopify/`).
- `src/pages/api/`: the HTTP API. `POST /api/tasks/:id/advance` runs one agent
  step and streams it; the app calls it again while there is a next agent, so
  no request outlives a serverless function.
- `src/app/`: the React app, mounted client-only by
  `src/pages/dashboard/[...path].astro`.

The marketing pages stay pre-rendered; `/dashboard` and `/api` run on demand
through the Vercel adapter.

### Running it

```sh
cp .env.example .env   # set ANTHROPIC_API_KEY (and SESSION_SECRET for production)
npm run dev            # http://localhost:4321/dashboard
```

Locally, data is kept as JSON files under `.data/`. On Vercel add a Redis
integration (Upstash / Vercel KV) so `KV_REST_API_URL` and `KV_REST_API_TOKEN`
are set, plus `ANTHROPIC_API_KEY` and `SESSION_SECRET`. `AGENTIFY_FAKE_LLM=1`
swaps the model for a scripted stand-in, for UI work without credentials.

The team runs on the server: a step finishes, saves, and starts the next in a
fresh function invocation (`src/server/runner.ts`), so work continues with the
tab closed. The app polls `GET /api/tasks/:id/live` to show the running step.

Optional integrations, each switched on by its variables in `.env.example`:

- **Stores** (`src/server/shopify/`): a workspace has several stores; each
  connects to Shopify through the Agentify app (OAuth) or a pasted custom-app
  token. Agents read the live theme; Relay deploys to an unpublished preview.
- **GitHub** (`src/server/github/`): a store can be bound to a theme
  repository. Agents then read the repo, and Relay opens a pull request.
- **Checks** (`src/server/checks/`): Theme Check and JSON, schema and locale
  checks run on every build before QA reads it.
- **Attachments** (`src/server/attachments.ts`): images and small files in
  the thread; Atlas, Forge and Muse see the images.
- **Plans** (`src/agency/plans.ts`, `src/server/billing/`): token ceilings and
  store and seat limits per plan; Stripe checkout and webhook.
- **Members and email** (`src/server/members/`, `src/server/email/`):
  invitations, and an email when a request needs the client.

Unit tests live next to the code (`*.test.mjs`, `*.test.ts`); run one with
`node --experimental-strip-types --test <file>`.

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
