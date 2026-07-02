import { rootRoute } from "@tanstack/virtual-file-routes";
import { consoleRoutes } from "@executor-js/react/console-routes";

// The cloudflare-host console route tree — ONE definition read by
// vite.config.ts (dev/build) and packages/react's routes:gen (the committed
// routeTree.gen.ts).
//
// The route tree is composed, not hand-mirrored: the shared console routes
// come from @executor-js/react (the package whose shell/pages link to them);
// this app only owns its root (the Cloudflare-Access shell). To add
// app-specific routes, create web/routes/app and mount it inside the org
// scope via `orgScoped: [physical("", "app")]` — the directory must exist.
export const routes = rootRoute("__root.tsx", [
  ...consoleRoutes({ dir: "../../../../packages/react/src/routes" }),
]);
