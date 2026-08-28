import { useEffect } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue, useAtomRefresh } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { integrationAtom, integrationsOptimisticAtom } from "../api/atoms";
import { ErrorState } from "../components/error-state";
import { PageContainer } from "../components/page";
import { Skeleton } from "../components/skeleton";
import { isAsyncResultLoading } from "../lib/async-result";
import { useExecutorDocumentTitle } from "../lib/document-title";

// ---------------------------------------------------------------------------
// `/connect/<integration slug>` — the stable, shareable deep link that drops a
// person straight into the connect flow for ONE integration ("connect your
// Linear") instead of the dashboard.
//
// This page owns no connect UI of its own. It resolves the slug against the
// tenant's catalog and forwards into the integration detail page's existing
// account handoff (`?addAccount=1`), which is the same surface the detail
// page's own "Add connection" button opens — multi-method tab strips, OAuth
// popups, existing-connection lists and "add another account" all come for
// free, and stay correct as that flow evolves.
//
// Deliberately keyed on the INTEGRATION SLUG, not a plugin id: the slug is the
// catalog identity a customer can write down, whereas plugin routes are on
// their way out. The redirect is `replace: true` so the deep link does not
// linger in history and Back leaves the connect flow rather than bouncing.
// ---------------------------------------------------------------------------

export function ConnectIntegrationPage(props: { readonly integrationSlug: string }) {
  const { integrationSlug } = props;
  const slug = IntegrationSlug.make(integrationSlug);
  const integration = useAtomValue(integrationAtom(slug));
  const refreshIntegrations = useAtomRefresh(integrationsOptimisticAtom);
  const navigate = useNavigate();

  useExecutorDocumentTitle("Connect");

  // The catalog read is a client-side find over the integrations list, so an
  // unknown slug resolves to Success(null) rather than a failure — the missing
  // case is a not-found state, and only a genuine fetch failure is an error.
  const resolved = AsyncResult.isSuccess(integration) ? integration.value : null;
  const loading = isAsyncResultLoading(integration);
  const failed = AsyncResult.isFailure(integration);
  const missing = !loading && !failed && resolved === null;

  useEffect(() => {
    if (resolved === null) return;
    void navigate({
      to: "/{-$orgSlug}/integrations/$namespace",
      params: { namespace: String(resolved.slug) },
      // The NUMBER 1, so the router serializes the canonical `?addAccount=1`
      // that agent-generated handoff links already use (a string would be
      // quoted as `%221%22`).
      search: { tab: "accounts", addAccount: 1 },
      replace: true,
    });
  }, [resolved, navigate]);

  if (failed) {
    return (
      <ConnectStateFrame>
        <ErrorState message="Failed to load integrations" onRetry={refreshIntegrations} />
      </ConnectStateFrame>
    );
  }

  if (missing) {
    return (
      <ConnectStateFrame>
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
          <p className="mb-1 text-sm font-medium text-foreground/70">
            Unknown integration: {integrationSlug}
          </p>
          <p className="mb-5 text-xs text-muted-foreground">
            This integration is not in your workspace.
          </p>
          <Link
            to="/{-$orgSlug}"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Back to integrations
          </Link>
        </div>
      </ConnectStateFrame>
    );
  }

  // Loading, or resolved and mid-redirect: the same quiet placeholder, so the
  // hand-off never flashes an empty frame between catalog load and navigation.
  return (
    <ConnectStateFrame>
      <div className="space-y-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80" />
        <Skeleton className="h-32 w-full" />
      </div>
    </ConnectStateFrame>
  );
}

function ConnectStateFrame(props: { readonly children: React.ReactNode }) {
  return <PageContainer>{props.children}</PageContainer>;
}
