import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { AutumnProvider } from "autumn-js/react";
import { ExecutorProvider } from "@executor-js/react/api/provider";
import { setBaseUrl } from "@executor-js/react/api/base-url";
import { Toaster } from "@executor-js/react/components/sonner";
import { ExecutorPluginsProvider } from "@executor-js/sdk/client";
import { plugins as clientPlugins } from "virtual:executor/plugins-client";

import { findOrgByHandle, useAuth } from "../web/auth";
import { CloudNavTargets } from "../web/nav-targets";
import { OrgRouteProvider } from "../web/org-route";
import { Shell, ShellSkeleton } from "../web/shell";

export const Route = createFileRoute("/$org")({
  component: OrgLayout,
});

function OrgLayout() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { org: handle } = useParams({ from: Route.id });

  // Redirect to the first membership when the URL handle is unknown. We only
  // run the redirect once auth resolves to authenticated; loading/unauth are
  // already handled by AuthGate in __root.
  const matched = auth.status === "authenticated" ? findOrgByHandle(auth, handle) : null;
  const fallback = auth.status === "authenticated" ? (auth.organizations[0] ?? null) : null;

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    if (matched) return;
    if (!fallback) return;
    void navigate({ to: "/$org", params: { org: fallback.handle }, replace: true });
  }, [auth.status, matched, fallback, navigate]);

  if (auth.status !== "authenticated") return null;
  if (!matched) return null;

  // Point the executor API client at this org's prefixed routes. Done before
  // first render of the executor providers so all queries see the right URL.
  // The cloud app is single-tenant per page, so a one-shot setter is fine —
  // when the URL handle changes, this re-runs at the start of the next render.
  if (typeof window !== "undefined") {
    setBaseUrl(`${window.location.origin}/api/${matched.handle}`);
  }

  return (
    <OrgRouteProvider
      value={{ orgId: matched.id, orgName: matched.name, orgHandle: matched.handle }}
    >
      <CloudNavTargets>
        <AutumnProvider pathPrefix="/autumn">
          <ExecutorProvider fallback={<ShellSkeleton />}>
            <ExecutorPluginsProvider plugins={clientPlugins}>
              <Shell />
              <Toaster />
            </ExecutorPluginsProvider>
          </ExecutorProvider>
        </AutumnProvider>
      </CloudNavTargets>
    </OrgRouteProvider>
  );
}
