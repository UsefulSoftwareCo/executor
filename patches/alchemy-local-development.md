# Alchemy local identity patch

The pinned alchemy 2.0.0-beta.79 local Worker, R2 and Hyperdrive providers resolve
CloudflareEnvironment for accountId even when no remote binding exists. Its
credential-demand preflight is lazy, but these local lifecycle calls still force
credential resolution. An empty CI environment fails before starting workerd.

The patch assigns a local identity to newly emulated resources. Existing local
R2/Hyperdrive IDs and account metadata are retained. Worker configurations with
remote bindings still resolve the real Cloudflare environment. No live provider
is changed, and no dummy Cloudflare token is supplied. Both published JavaScript
and Bun/Worker TypeScript entry points are patched.

Verified through the actual Cloud E2E launcher with only PATH, HOME, TMPDIR and
SHELL retained, CI=true, and a fresh empty ALCHEMY_HOME. The application itself
runs under workerd with a disposable real Postgres database. Remove the patch
when the pinned upstream implements equivalent credential-free local providers.
