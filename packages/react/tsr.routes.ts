import { rootRoute } from "@tanstack/virtual-file-routes";

import { consoleRoutes } from "./src/console-routes";

// The package-local codegen (`bun run routes:gen` → tsr.config.json) must mount
// the shared route files exactly the way apps do — same virtual tree, same
// `/{-$orgSlug}` scope — or the generator would rewrite the files'
// `createFileRoute()` ids back and forth between the two shapes.
export const routes = rootRoute("__root.tsx", consoleRoutes({ dir: "." }));
