# Executor docs

The Executor documentation site, built with [Mintlify](https://mintlify.com).
This is a standalone Mintlify project (no `package.json`, so it is not part of
the bun workspace; Mintlify builds it in its own cloud).

## Develop

Run the Mintlify CLI directly. It needs an LTS Node (it rejects Node 25+):

```bash
bunx mint@latest dev            # http://localhost:3000
bunx mint@latest broken-links   # validate internal links
```

Edit the `.mdx` pages and the navigation in [`docs.json`](./docs.json); the dev
server hot-reloads.

## How it's served

Mintlify hosts the built site at `executor.mintlify.dev`. The Executor Cloud
worker reverse-proxies it onto the first-party origin at `executor.sh/docs`
(see `apps/cloud/src/edge/docs.ts`), so the public docs live at
`executor.sh/docs` instead of a `*.mintlify.dev` subdomain.

Mintlify is configured to host under the `/docs` subpath (Settings → Domain
setup → **Host at /docs**), so it serves `/docs/*` paths that the proxy
forwards unchanged. A config change like that only takes effect on the next
build, so push a commit to `apps/docs` to redeploy.

To deploy from this directory, point the Mintlify GitHub app at `apps/docs`.
