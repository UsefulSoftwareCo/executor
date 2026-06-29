import { physical, rootRoute } from "@tanstack/virtual-file-routes";
import { consoleRoutes } from "@executor-js/react/console-routes";

// The self-host console route tree — ONE definition read by vite.config.ts
// (dev/build) and packages/react's routes:gen (the committed routeTree.gen.ts).
//
// Shared console routes come from @executor-js/react (see its
// console-routes.ts); this app owns its root (the Better Auth shell) and the
// self-host-specific routes: web/routes/app (admin, api-keys) mounts INSIDE
// the shared `{-$orgSlug}` scope, web/routes/public (the /join/$code invite
// page) stays bare — it's reached without a session, before any org slug is
// known.
export const routes = rootRoute("__root.tsx", [
  ...consoleRoutes({
    dir: "../../../../packages/react/src/routes",
    orgScoped: [physical("", "app")],
  }),
  physical("", "public"),
]);
