// ---------------------------------------------------------------------------
// @executor-js/plugin-openapi/client — `defineClientPlugin` entry.
//
// Aggregates the openapi plugin's frontend contributions into a single
// declarative spec. The host's Vite plugin reads this via
// `virtual:executor/plugins-client`, so the host's sources page derives
// the openapi entry from here without a direct `*/react` import.
//
// The richer add/edit/summary components still live in `./react`; this
// module just imports them and bundles them into the spec.
// ---------------------------------------------------------------------------

import { defineClientPlugin } from "@executor-js/sdk/client";

import { openApiIntegrationPlugin } from "./source-plugin";

export default defineClientPlugin({
  id: "openapi" as const,
  integrationPlugin: openApiIntegrationPlugin,
});
