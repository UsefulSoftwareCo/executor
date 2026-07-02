// Regenerate this package's committed routeTree.gen.ts from tsr.routes.ts —
// the same virtual tree consumers compose via consoleRoutes(). Run with
// `bun run routes:gen` after changing the console route contract; the apps
// each have their own `routes:gen` for their trees.
import { fileURLToPath } from "node:url";

import { generateRouteTree } from "../src/route-tree-gen";
import { routes } from "../tsr.routes";

await generateRouteTree({
  root: fileURLToPath(new URL("..", import.meta.url)),
  routesDirectory: fileURLToPath(new URL("../src/routes", import.meta.url)),
  generatedRouteTree: fileURLToPath(new URL("../src/routes/routeTree.gen.ts", import.meta.url)),
  virtualRouteConfig: routes,
});
console.log("generated packages/react route tree");
