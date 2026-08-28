import { Suspense } from "react";
import { useAtomRefresh } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useIntegrationPlugins } from "@executor-js/sdk/client";
import { integrationsOptimisticAtom } from "../api/atoms";
import { trackEvent } from "../api/analytics";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { PageContainer } from "../components/page";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AddIntegrationPage(props: {
  pluginKey: string;
  url?: string;
  preset?: string;
  namespace?: string;
}) {
  useExecutorDocumentTitle("Add integration");
  const { pluginKey, url, preset, namespace } = props;
  const navigate = useNavigate();
  const integrationPlugins = useIntegrationPlugins();
  const refreshIntegrations = useAtomRefresh(integrationsOptimisticAtom);

  const plugin = integrationPlugins.find((p) => p.key === pluginKey);

  if (!plugin) {
    return (
      <PageContainer>
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
          <p className="mb-1 text-sm font-medium text-foreground/70">
            Unknown integration type: {pluginKey}
          </p>
          <p className="mb-5 text-xs text-muted-foreground">
            This integration plugin is not registered.
          </p>
          <Link
            to="/{-$orgSlug}"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Back to integrations
          </Link>
        </div>
      </PageContainer>
    );
  }

  const AddComponent = plugin.add;

  return (
    <PageContainer>
      <div className="flex min-h-full flex-col">
        <Suspense fallback={null}>
          <AddComponent
            initialUrl={url}
            initialPreset={preset}
            initialNamespace={namespace}
            onComplete={(slug?: string) => {
              trackEvent("integration_added", {
                plugin_key: pluginKey,
                ...(slug ? { integration_slug: slug } : {}),
              });
              refreshIntegrations();
              void navigate(
                slug
                  ? {
                      to: "/{-$orgSlug}/integrations/$namespace",
                      params: { namespace: slug },
                      search: {},
                    }
                  : { to: "/{-$orgSlug}" },
              );
            }}
            onCancel={() => {
              trackEvent("integration_add_cancelled", { plugin_key: pluginKey });
              void navigate({ to: "/{-$orgSlug}" });
            }}
          />
        </Suspense>
      </div>
    </PageContainer>
  );
}
