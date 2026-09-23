# Shared hosted UI

Reusable React pages and components for cloud and self-host. This package has no
browser entry or route tree and imports neither host. Each host builds its own
SPA with TanStack Router; neither uses SSR.

- `src/contracts/api.ts`: common Effect Atom queries derived from `HostedApi`.
- `src/contracts/auth.ts`: typed Better Auth operations and session state through Effect Atom.
- `src/contracts/organization.ts`: organization selection, membership mutations, and inventory atoms.
- `src/implementation/pages/`: shared login, organization, invitation, inventory, and Catalog screens.
- `src/implementation/components/auth.tsx`: session boundary and logout control.
- `src/implementation/components/shell.tsx`: layout accepting navigation and page content.
- `src/implementation/components/navigation.tsx`: common links for hosts to compose.
- `@executor-js/ui/components/*`: shared shadcn primitives from `packages/ui`.
- `src/implementation/styles/`: hosted layout over the shared UI theme and fonts.
- `vite.ts`: shared build configuration; each consumer generates its own route tree.

Executable frontends live in `../cloud/web` and `../self-host/web`. Add
host-specific pages, navigation, and atoms there. Their API calls can use that
host's API contract without making the shared package depend on it.

The cloud build uses TanStack's route-generation hook to emit its `_redirects`
asset. The shared Vite configuration accepts route plugins without depending on
Cloudflare. Self-host continues to serve its SPA through its filesystem adapter.
Organization pages share one `/org/*` rewrite; TanStack resolves their nested
routes and not-found views. API, Git, docs and asset paths keep their own handling.
The combined site build puts fixed redirects first and rejects files over
Cloudflare's 2,000 static / 100 dynamic rule limits before Worker upload.

Run `bun run hosted:self-host:web:dev` from the repository root for self-host HMR
on port 4410, proxying to Docker on port 4400. Run `bun run hosted:cloud:web:dev`
for cloud HMR on port 4412, proxying to the local Alchemy Worker on port 4411.
Both accept `HOSTED_API_URL` as an override.
Set the server's `BETTER_AUTH_URL` to the frontend origin when using HMR.

See [hosted deployment](../README.md) for build and deployment commands.
