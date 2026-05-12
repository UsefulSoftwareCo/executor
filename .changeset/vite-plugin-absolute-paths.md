---
"@executor-js/vite-plugin": patch
---

`virtual:executor/plugins-client` now emits absolute `file://` URLs for each
plugin's `./client` subpath instead of bare specifiers like
`@executor-js/plugin-openapi/client`. The plugin already resolved those
imports against the consumer's `executor.config` directory to validate
them; it now uses the resolved path directly.

Fixes a resolution failure for hosts where Vite's `root` differs from the
package that depends on the plugins. For example, `apps/local`'s Vite
config sets `root: packages/app/`, so Vite walked node_modules upward from
`packages/app/` — which doesn't see the plugin packages installed under
`apps/local/node_modules/`. Node's resolver still honors each plugin's
`exports./client` conditions when we resolve, so behavior is unchanged
for hosts that previously worked.
