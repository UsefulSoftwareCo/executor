import { WorkflowStart, WorkflowTerminate } from "@executor-js/ui/dashboard/workflow-actions";
import type { App } from "@executor-js/sdk";
import { AppWorkflows } from "@executor-js/ui/dashboard/app-workflows";
import { AppWebhooks, WebhookSourceConfigurations } from "@executor-js/ui/dashboard/webhooks";
import { Button } from "@executor-js/ui/components/button";
import { workflowBindings, webhookBindings } from "../../contracts/resources.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";
export function AppResources({
  app,
  view,
}: {
  readonly app: App;
  readonly view: "workflows" | "webhooks";
}) {
  const { organization, slug } = useOrganizationRoute();
  if (view === "workflows") {
    const bindings = workflowBindings({
      organization,
      app: app.id,
      version: app.activeVersion ?? undefined,
    });
    return (
      <AppWorkflows
        key={String(app.activeVersion)}
        app={app}
        bindings={bindings}
        start={(definition, onStarted) => (
          <WorkflowStart
            key={definition.name}
            definition={definition}
            start={bindings.start(definition.name)}
            editable
            onStarted={onStarted}
            Failure={HostedFailure}
          />
        )}
        runAction={(run, workflow, cursor) => (
          <WorkflowTerminate
            run={run}
            terminate={bindings.terminate(run.id, workflow, cursor)}
            editable
            Failure={HostedFailure}
          />
        )}
        Failure={HostedFailure}
      />
    );
  }
  const hooks = webhookBindings({ organization, app: app.id });
  return (
    <AppWebhooks
      query={hooks.query}
      retry={hooks.retry}
      Failure={HostedFailure}
      setupLink={(hook) => (
        <Button size="sm" variant="outline" asChild>
          <a href={`/org/${encodeURIComponent(slug)}/webhooks/${app.id}/${hook.id}`}>
            {hook.status === "disabled" ? "Finish removal" : "Complete setup"}
          </a>
        </Button>
      )}
    >
      <WebhookSourceConfigurations
        query={hooks.sources}
        configure={hooks.configure}
        Failure={HostedFailure}
      />
    </AppWebhooks>
  );
}
