// ---------------------------------------------------------------------------
// @executor-js/plugin-toolkits/client — the frontend half.
//
// The Vite plugin resolves `${packageName}/client` for every server plugin
// registered in `executor.config.ts` and feeds the default export into
// `<ExecutorPluginsProvider>`, so registering `toolkitsPlugin()` server-side is
// all it takes for this page (and its "Toolkits" nav entry) to mount.
//
// Server-only deps (Effect runtime, Node, executor.config) MUST NOT be imported
// here — this entry is bundled into the frontend.
// ---------------------------------------------------------------------------

import { defineClientPlugin } from "@executor-js/sdk/client";

import { ToolkitsPage } from "./ToolkitsPage";

export default defineClientPlugin({
  id: "toolkits" as const,
  pages: [
    {
      path: "/",
      component: ToolkitsPage,
      nav: { label: "Toolkits" },
    },
  ],
});
