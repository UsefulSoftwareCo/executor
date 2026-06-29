import { createFileRoute } from "@tanstack/react-router";

import { safeReturnTo } from "../../auth/return-to";
import { LoginPage } from "../../web/pages/login";

// The signed-out landing page. The SSR auth gate (auth/ssr-gate.ts) sends
// signed-out document requests here with ?returnTo=<the path they wanted>,
// and bounces already-signed-in visitors straight back to it.
export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    returnTo:
      safeReturnTo(typeof search.returnTo === "string" ? search.returnTo : null) ?? undefined,
  }),
  component: LoginRoute,
});

function LoginRoute() {
  const { returnTo } = Route.useSearch();
  return <LoginPage returnTo={returnTo} />;
}
