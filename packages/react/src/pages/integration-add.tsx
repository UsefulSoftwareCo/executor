import { Suspense } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useIntegrationPlugins } from "@executor-js/sdk/client";
import { trackEvent } from "../api/analytics";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AddIntegrationPage(props: {
  pluginKey: string;
  url?: string;
  preset?: string;
  namespace?: string;
}) {
  const { pluginKey, url, preset, namespace } = props;
  const navigate = useNavigate();
  const integrationPlugins = useIntegrationPlugins();

  const plugin = integrationPlugins.find((p) => p.key === pluginKey);

  if (!plugin) {
    return (
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
            <p className="text-sm font-medium text-foreground/70 mb-1">
              Unknown integration type: {pluginKey}
            </p>
            <p className="text-xs text-muted-foreground mb-5">
              This integration plugin is not registered.
            </p>
            <Link
              to="/{-$orgSlug}"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Back to integrations
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const AddComponent = plugin.add;

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-4xl flex-col px-6 py-10 lg:px-10 lg:py-14">
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
              void navigate(
                slug
                  ? { to: "/{-$orgSlug}/integrations/$namespace", params: { namespace: slug } }
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
    </div>
  );
}
