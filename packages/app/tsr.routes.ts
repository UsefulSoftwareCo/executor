import { physical, rootRoute } from "@tanstack/virtual-file-routes";
import { consoleRoutes } from "@executor-js/react/console-routes";

// The local/desktop console route tree — ONE definition read by vite.ts
// (dev/build) and packages/react's routes:gen (the committed routeTree.gen.ts).
//
// Shared console routes come from @executor-js/react (see its
// console-routes.ts); this app owns its root and the local-specific routes
// under src/routes/app. /secrets is excluded: the local app's variant shows
// credential-provider info. App routes mount INSIDE the shared `{-$orgSlug}`
// scope (local never sets the param, so URLs stay bare) so the override masks
// the shared route id.
export const routes = rootRoute("__root.tsx", [
  ...consoleRoutes({
    dir: "../../../react/src/routes",
    exclude: ["/secrets"],
    orgScoped: [physical("", "app")],
  }),
]);
