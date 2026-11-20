import { WorkflowStart, WorkflowTerminate } from "@executor-js/ui/dashboard/workflow-actions";
/** Thin product bindings for workflow and webhook views. */
import type { App } from "@executor-js/sdk";
import { AppWorkflows } from "@executor-js/ui/dashboard/app-workflows";
import { AppWebhooks, WebhookSourceConfigurations } from "@executor-js/ui/dashboard/webhooks";
import { Button } from "@executor-js/ui/components/button";
import { workflowBindings, webhookBindings } from "../../contracts/resources.ts";
import { versionSourceAtom } from "../../contracts/api.ts";
import { Failure } from "../components/common.tsx";
/** Workflow definitions and starts use the app's linked accounts; run history is the app's. */
export function AppResources({
  app,
  view,
}: {
  readonly app: App;
  readonly view: "workflows" | "webhooks";
}) {
  if (view === "workflows") {
    const bindings = workflowBindings({
      app: app.id,
      version: app.activeVersion ?? undefined,
    });
    // Local has one person, who can always read the source.
    const source =
      app.activeVersion === null
        ? undefined
        : versionSourceAtom({ app: app.id, version: app.activeVersion });
    return (
      <AppWorkflows
        key={String(app.activeVersion)}
        app={app}
        bindings={{ ...bindings, source }}
        start={(definition, onStarted) => (
          <WorkflowStart
            key={definition.name}
            definition={definition}
            start={bindings.start(definition.name)}
            editable
            onStarted={onStarted}
            Failure={Failure}
          />
        )}
        runAction={(run, workflow, cursor) => (
          <WorkflowTerminate
            run={run}
            terminate={bindings.terminate(run.id, workflow, cursor)}
            editable
            Failure={Failure}
          />
        )}
        Failure={Failure}
      />
    );
  }
  const hooks = webhookBindings({ app: app.id });
  return (
    <AppWebhooks
      query={hooks.query}
      retry={hooks.retry}
      Failure={Failure}
      setupLink={(hook) => (
        <Button size="sm" variant="outline" asChild>
          <a href={`/webhooks/${app.id}/${hook.id}`}>
            {hook.status === "disabled" ? "Finish removal" : "Complete setup"}
          </a>
        </Button>
      )}
    >
      <WebhookSourceConfigurations
        query={hooks.sources}
        configure={hooks.configure}
        Failure={Failure}
      />
    </AppWebhooks>
  );
}
