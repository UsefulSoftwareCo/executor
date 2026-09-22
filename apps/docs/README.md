# Documentation site

The Executor documentation, built by [Blume](https://useblume.dev) and served at
`/docs` on the same origin as the marketing site and the dashboard.

The site is **static**. `blume build` prerenders every page, so there is no
server and no request-time code. Blume is here mainly for the agent-facing half
of the output: `llms.txt`, `llms-full.txt`, a `.md` and `.mdx` variant of every
page, a JSON API and `agent-readability.json`, all emitted by the same build.

## Editing

Each page is one Markdown or MDX file under `content/`. The path below that
directory is the route; `index.mdx` is the docs root. Frontmatter needs a
`title` and a `description`. Unknown frontmatter keys fail the build.

Write internal links as bare routes — `/mcp-clients`, not `/docs/mcp-clients`.
`deployment.base` in `blume.config.ts` moves the whole site under `/docs` and
rewrites the links, the sitemap, the canonicals and `llms.txt` to match. The one
deliberate exception is the absolute `https://v2.executor.sh` link on the index
page: it points at the hosted dashboard, which is not a docs page, so it must
not pick up the base. `blume audit` reports it as a warning for that reason.

`blume.config.ts` owns the sidebar: the group labels, the order, and which pages
appear. A page that is not listed there is not in the navigation. Put images and
other static files in `public/`.

Use `.mdx` when a page needs a component and `.md` when it is only prose.
Blume's components need no import. The set in use here is `Steps`, `Tabs`,
`CodeGroup`, `CardGroup`/`Card` and `FileTree`. The `.md` variant downlevels all
of them to plain Markdown, so an agent reading a page sees an ordered list where
a reader sees steps.

Keep the existing voice: short, plain sentences. Use the vocabulary in
`CONTEXT.md` — provider, account, app, deployment, tool, approval, organization.
Do not use integration, connection, toolkit or policy. Never put a customer name
or customer data in a page; use synthetic examples. Mark anything not yet
shipped as "coming later" rather than documenting it as available.

## The page frame

The docs render inside the marketing site's rail, so `/` and `/docs` read as one
site. Blume's own `RootLayout` still builds the page, because it is the docs:
the article header, the prose, the code-block chrome, the "On this page"
outline, the page actions, the feedback row, the pagination and every
agent-facing artefact come from it. `components.ts` replaces three of its slots
and nothing else:

- `layout.Header` → `components/DocsRail.astro`. The marketing rail, which is
  `apps/marketing/src/components/variants/rail-b.astro` itself rather than a
  copy: the main site navigation, Blume's search button and the documentation
  tree from `components/DocsNav.astro` in the rail's secondary slot.
- `layout.Sidebar` → `components/NoSidebar.astro`, which renders nothing.
  The tree is in the rail, so Blume's own navigation column would be a second
  copy of it.
- `layout.Footer` → `apps/marketing/src/components/SiteFooter.astro`, the
  footer `RailFrame.astro` gives every marketing page.

`styles.css` holds the small amount of chrome that follows from that. It places
the rail — a fixed column in the same centered 1,240px frame as home from
1024px, and a sticky bar below it, where the tree
becomes a "Documentation" menu underneath — takes the empty navigation column
out of Blume's grid, and lifts the outline to the top of the page now that no
header sits above it. It uses the marketing tokens and adds no colour and no
face of its own. Its rules sit outside every Tailwind layer, which is what lets
them win over the utility classes on Blume's own elements without `!important`.

Both builds import `apps/marketing/src/styles/site-frame.css` for the frame
width, rail width and content gutter.

`theme.css` is the only Tailwind entry on a docs page. It scans the marketing
components and repeats their theme tokens, and it maps Blume's `--blume-*`
tokens onto the same values. That is why the rail is imported directly rather
than through the marketing `Layout.astro`: that layout imports the marketing
Tailwind entry, and two Tailwind builds on one page put two copies of the
shared base utilities in the cascade, where the later copy silently beats the
earlier one's responsive variants.

`public/favicon.png` is the brand mark Blume finds by convention and puts in
the document head; there is no config key for it. `public/favicon-192.png` is
the same image under the name the rail and the footer ask for, which the
marketing build also serves. Both resolve against their own base, so the docs
build serves its own copy at `/docs`.

Blume 1.7.3 only reads SVG logos for generated Open Graph cards.
`public/executor-og-logo.svg` embeds the same `favicon-192.png` image, and
`seo.og.logo` selects it so cards show the Executor mark instead of Blume's
default initial. If the mark changes, replace the embedded PNG as well.

## Building

From the repository root:

- `bun run docs:build` builds the static site into `apps/docs/dist`.
- `bun run docs:dev` runs Blume alone on port 4322. The rail links to `/`,
  `/blog`, `/pricing` and `/login`, which only exist on the combined cloud
  origin.
- `bun run hosted:cloud:site:build` builds marketing, the documentation and the
  cloud dashboard, then assembles the Alchemy asset directory. The documentation
  lands under `.generated/site/docs/`.

`apps/hosted/cloud/scripts/build-site.ts` carries the whole Blume output below
`docs/`, not only the HTML, and writes the `_redirects` rewrites. Asset serving
uses `htmlHandling: "none"`, so every page needs an explicit rewrite; the
canonical route has no trailing slash. It also composes the `_headers` files
from all three builds into one at the asset root, because the asset layer reads
those directives only from there. Blume's block already carries the `/docs`
prefix, and it is what gives `/docs/*.md` a `text/markdown` content type and
`/docs/llms.txt` a `text/plain` one.

## Analytics

The documentation reports to the same PostHog project as the marketing site and
the dashboard. It captures a page view per navigation — the initial load and
every client-router swap — and one `feedback` event from the "Was this page
helpful?" row, carrying `helpful`, `path` and `title`. Nothing else: there is
no autocapture, no session replay and no exception capture. The pages are
static, so no product cookie and no authorization header exists to leak.

The key is never in this repository. `blume.config.ts` reads
`PUBLIC_POSTHOG_KEY`, `PUBLIC_POSTHOG_PATH`, `PUBLIC_POSTHOG_HOST`,
`PUBLIC_EXECUTOR_ENVIRONMENT` and `PUBLIC_EXECUTOR_RELEASE` from the build
environment. `apps/hosted/cloud/src/main.ts` binds them onto the Site build
command from the PostHog stack outputs, and that command runs
`hosted:cloud:site:build`, so the documentation build inherits the same values
as the marketing build. Without `PUBLIC_POSTHOG_KEY` the config emits no
`analytics` block at all, so a local build, `blume dev` and a stage without
PostHog stay clean. There is no default key and no fallback. Blume also gates
its own injection on a production build.

`PUBLIC_POSTHOG_PATH` is the first-party ingest path: a retained random path
under `/api/` that the Worker rewrites onto PostHog. It is origin-relative, so
one build serves every stage, and PostHog's own host is never contacted from
the browser. Blume's PostHog adapter takes only a key and a host, so the rest
of the shared ingest settings are applied by one short inline script beside it,
which extends the configuration the loader has queued before the library
arrives: the single delivery hop over `beacon → <path>/push`, the captures that
stay off, and the `product_version`, `surface`, `environment`, `release` and
`executor_test` properties every Executor surface registers. That script
depends on the loader's queue, so check it if Blume changes its adapter.

## Checking

- `bun run docs:validate` — `blume validate`. Checks every internal, anchor and
  asset link. Errors on a broken page link. Runs offline and takes a second, so
  run it after any edit that adds or moves a link.
- `bun run docs:audit` — `blume audit` over the built site. SEO and site-health
  checks: titles, descriptions, canonicals, headings, orphan pages, the sitemap.
  Build first. It fails on errors only; warnings are advisory.

  The script skips one check, `BLUME_AUDIT_LINK_TO_BROKEN`. The audit reads
  `dist` as if it were the whole site, but this build is one part of one origin:
  the rail and the footer link to `/blog`, `/pricing`, `/login`, `/privacy` and
  `/terms`, which the marketing build and the dashboard serve. Every one of
  those is reported as a broken page here. `blume validate` already errors on a
  broken link inside the documentation itself, which is the case this check
  would otherwise catch.

- `bun run docs:eval` — `blume eval`. The docs' own test suite. An agent answers
  the questions in `evals.yaml` using **only** these docs, over a private MCP
  server built from `content/`, and a second agent grades each answer against
  the facts the question lists. A question fails when the docs do not state the
  answer, which is the point: what is not written does not exist.

`evals.yaml` holds the questions a new user or an agent asks on their first day.
Add one when a page makes a promise that a future edit could quietly break. Do
not weaken an `expected` fact to make a run green; fix the page instead.

`blume eval` shells out to an agent CLI you already have installed — Claude Code
by default, or `--agent codex`. Blume holds no API keys of its own, so whichever
CLI you use must already be signed in; there is no environment variable to set
here and no key belongs in this repository. Each question is two model sessions,
so a full run costs real money and several minutes. Run it on documentation
changes, not on every edit.

## Follow-ups

Two Blume features are deliberately off, because both need `output: "server"`
and this site is static:

- **Ask AI** (`ai.ask`) — the in-page assistant. It needs a request-time
  endpoint and a model provider key.
- **The hosted MCP server** (`ai.mcp`) — Blume serving `search_docs`/`get_page`
  over HTTP at `/docs/mcp`. Note that Executor already serves its own product
  MCP endpoint at `/mcp` on the same origin, so the two would have to be kept
  clearly apart.

Until then, agents read the docs through `llms.txt`, `llms-full.txt` and the
per-page `.md` URLs, which the static build already publishes.

Content negotiation on `Accept: text/markdown` also needs a server build. Agents
on this deployment fetch the `.md` URL directly instead, and
`agent-readability.json` advertises it that way.
