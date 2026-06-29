import { physical, rootRoute } from "@tanstack/virtual-file-routes";
import { consoleRoutes } from "@executor-js/react/console-routes";

// The cloud console route tree — ONE definition read by both vite.config.ts
// (the dev/build plugin) and `bun run routes:gen` (which refreshes the
// committed routeTree.gen.ts).
//
// Shared console routes come from @executor-js/react (see its
// console-routes.ts); cloud owns its root (WorkOS auth + billing shell) and
// the cloud-specific routes under src/routes/app. Excluded shared paths are
// intentional divergence: cloud's /secrets redirects to / (credential storage
// is product plumbing here), its /resume page is the cloud variant, and
// client plugin pages aren't wired up on cloud.
//
// Org-scoped vs bare: console routes and most app routes live INSIDE the
// optional `{-$orgSlug}` scope; src/routes/bare stays OUTSIDE it — /login is
// for signed-out visitors and /create-org and /setup-mcp are reached
// precisely when the user has no organization yet.
export const routes = rootRoute("__root.tsx", [
  ...consoleRoutes({
    dir: "../../../../packages/react/src/routes",
    exclude: ["/secrets", "/resume/$executionId", "/plugins/$pluginId/$"],
    orgScoped: [physical("", "app")],
  }),
  physical("", "bare"),
]);
