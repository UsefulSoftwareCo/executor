// Regenerate the committed routeTree.gen.ts from tsr.routes.ts — the same
// virtual tree vite.config.ts feeds the Start plugin. Run with
// `bun run routes:gen` after changing routes or the shared console contract.
import { fileURLToPath } from "node:url";

import { generateRouteTree } from "@executor-js/react/route-tree-gen";

import { routes } from "../tsr.routes";

await generateRouteTree({
  root: fileURLToPath(new URL("..", import.meta.url)),
  routesDirectory: fileURLToPath(new URL("../src/routes", import.meta.url)),
  generatedRouteTree: fileURLToPath(new URL("../src/routeTree.gen.ts", import.meta.url)),
  virtualRouteConfig: routes,
  // The Start vite plugin appends this Register block when IT generates the
  // tree; reproduce it so a CLI regen matches a dev-server run.
  routeTreeFileFooter: [
    "",
    "import type { getRouter } from './router.tsx'",
    "import type { startInstance } from './start.ts'",
    "declare module '@tanstack/react-start' {",
    "  interface Register {",
    "    ssr: true",
    "    router: Awaited<ReturnType<typeof getRouter>>",
    "    config: Awaited<ReturnType<typeof startInstance.getOptions>>",
    "  }",
    "}",
  ],
});
console.log("generated apps/cloud route tree");
