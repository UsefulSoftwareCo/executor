import { Outlet, createRootRoute } from "@tanstack/react-router";

// Typing-only root for the package-local console route tree (see
// console-router.ts). Apps never mount this file — each app supplies its own
// __root.tsx (the auth shell is what genuinely differs per app) in its
// virtualRouteConfig and composes the shared routes via consoleRoutes().
export const Route = createRootRoute({ component: Outlet });
