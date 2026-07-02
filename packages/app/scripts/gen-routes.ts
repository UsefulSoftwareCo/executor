// Regenerate the committed routeTree.gen.ts from tsr.routes.ts — the same
// virtual tree vite.ts feeds the router plugin. Run with
// `bun run routes:gen` after changing routes or the shared console contract.
import { fileURLToPath } from "node:url";

import { generateRouteTree } from "@executor-js/react/route-tree-gen";

import { routes } from "../tsr.routes";

await generateRouteTree({
  root: fileURLToPath(new URL("..", import.meta.url)),
  routesDirectory: fileURLToPath(new URL("../src/routes", import.meta.url)),
  generatedRouteTree: fileURLToPath(new URL("../src/routeTree.gen.ts", import.meta.url)),
  virtualRouteConfig: routes,
});
console.log("generated packages/app route tree");
