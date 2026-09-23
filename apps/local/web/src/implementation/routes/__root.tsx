import { ExecutorDevtools } from "@executor-js/devtools";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { localPageTitle } from "../../contracts/navigation.ts";
import { NotFoundPage } from "../components/not-found.tsx";
import { useLocation } from "@tanstack/react-router";
import { DocumentTitleProvider, productTitle } from "@executor-js/ui/hooks/document-title";

/** Standalone connection handoffs and authenticated dashboard routes share only the router. */
export const Route = createRootRoute({ component: Root, notFoundComponent: NotFoundPage });

function Root() {
  const { pathname } = useLocation();
  return (
    <DocumentTitleProvider fallbackTitle={productTitle(localPageTitle(pathname))}>
      <Outlet />
      <ExecutorDevtools />
    </DocumentTitleProvider>
  );
}
