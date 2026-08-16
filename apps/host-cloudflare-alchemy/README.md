# Executor Cloudflare infrastructure with Alchemy

This package is an opt-in Alchemy v2 deployment for
`@executor-js/host-cloudflare`. The Alchemy stack is an Effect program, while
it deliberately deploys the existing async Worker entry and Durable Object
classes unchanged.

## Why a separate workspace?

Executor currently uses Effect `4.0.0-beta.59`. Alchemy `2.0.0-beta.66`
requires Effect `>=4.0.0-beta.100`, so deployment tooling uses its own
compatible Effect dependency and does not force an application-wide upgrade.

## Fresh deployment

For local deployments, authenticate through Alchemy's browser-based profile and
bootstrap its account-wide remote state store:

```bash
bun run --cwd apps/host-cloudflare-alchemy auth
bun run --cwd apps/host-cloudflare-alchemy auth:status
bun run --cwd apps/host-cloudflare-alchemy state:bootstrap
```

`auth` runs `alchemy login --configure`, so it can select the disposable
Cloudflare account without storing an API token in this repository. The
bootstrap command creates or updates Alchemy's `alchemy-state-store` Worker; it
does not deploy Executor. For non-interactive CI, use
`bun run --cwd apps/host-cloudflare-alchemy token:create` to mint a scoped token,
then provide `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` through the CI
secret store.

Copy the environment template and provide the installation-specific Worker
configuration. Cloudflare credentials may stay commented when using an Alchemy
profile:

```bash
cp apps/host-cloudflare-alchemy/.env.example apps/host-cloudflare-alchemy/.env
$EDITOR apps/host-cloudflare-alchemy/.env

bun run --cwd apps/host-cloudflare plan:alchemy
bun run --cwd apps/host-cloudflare deploy:alchemy
```

Never commit `.env`; it contains the Worker encryption key.

### Isolated validation in an existing account

Use the `validation` commands when a separate test account is impractical:

```bash
bun run --cwd apps/host-cloudflare plan:alchemy:validation
bun run --cwd apps/host-cloudflare deploy:alchemy:validation
```

This stage does not adopt resources and uses the isolated physical names
`executor-cloudflare-validation`, `executor-validation`, and
`executor-blobs-validation`. It still shares the account-wide Alchemy state
store and Cloudflare usage limits. Remove only that stage with
`bun run --cwd apps/host-cloudflare-alchemy destroy:validation` after checking
the destroy plan.

The deploy command builds the SPA and verifies the stable MCP Apps shell asset
before running the `prod` Alchemy stack. The stack creates:

- Worker `executor-cloudflare`
- D1 database `executor`
- R2 bucket `executor-blobs`
- SQLite-backed `McpSessionDO` and `McpExecutionOwnerDirectoryDO` namespaces
- static assets and the `ASSETS` binding

Alchemy's Worker provider defaults newly hosted Durable Object classes to
SQLite, emits `ASSETS` whenever static assets are configured, and matches
foreign Durable Object classes by binding name during the first adopting
deploy. The existing binding and class names are therefore intentionally
unchanged.

Create the Cloudflare Access application before deploying so its audience can
be supplied as `ACCESS_AUD`. Managed OAuth for interactive MCP clients still
uses the setup described by `apps/host-cloudflare/scripts/preview.ts`; Alchemy's
current Access Application resource does not expose `oauth_configuration`.

## Adopting an existing Wrangler deployment

Do not run adoption against production without first recovering the exact
plaintext `EXECUTOR_SECRET_KEY` used by the existing Worker. Rotating that key
makes encrypted credentials already stored in D1 unreadable.

After rehearsing against a disposable Wrangler-created deployment, inspect the
adoption-aware dry run, then use the adoption command:

```bash
bun run --cwd apps/host-cloudflare plan:alchemy:adopt
bun run --cwd apps/host-cloudflare deploy:alchemy:adopt
```

The second command changes ownership and deploys the stack. Do not approve it
unless the dry run preserves every stateful resource and binding.

For reference, the underlying adoption command is:

```bash
alchemy deploy --stage prod --adopt
```

Alchemy currently does not expose Cloudflare's `keep_bindings` upload option.
Every live Worker binding must therefore be represented in `alchemy.run.ts`
before adoption. Copy any existing `SELF_HOSTED_ORG_ID`,
`SELF_HOSTED_ORG_NAME`, `SELF_HOSTED_ORG_SLUG`, `ALLOW_LOCAL_NETWORK`, and
`VITE_PUBLIC_SITE_URL` values into `.env`; omitted organization ID/name values
default to `default`/`Default`, while the other three remain absent. Keep the
Wrangler deployment path available until a plan and post-deploy smoke test
confirm that D1, R2, both Durable Object classes, static assets, Access
variables, and the existing secret are preserved.

## Current scope

Wrangler remains the default deploy command, local development server, and type
generator while this path is validated. This package does not automate the
Cloudflare Access application because Alchemy cannot yet create it with the
Managed OAuth configuration required by Executor's MCP endpoint.
