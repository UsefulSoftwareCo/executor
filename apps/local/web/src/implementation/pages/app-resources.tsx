import { WorkflowStart, WorkflowTerminate } from "@executor-js/ui/dashboard/workflow-actions";
/** Thin product bindings for the selected profile resource views. */
import type { AccountContext } from "@executor-js/ui/dashboard/account-group";
import { AppWorkflows } from "@executor-js/ui/dashboard/app-workflows";
import { AppWebhooks, WebhookConfiguration } from "@executor-js/ui/dashboard/webhooks";
import { ProfileStatus } from "@executor-js/ui/dashboard/profile-status";
import { Button } from "@executor-js/ui/components/button";
import { workflowBindings, webhookBindings } from "../../contracts/resources.ts";
import { profileMutations } from "../../contracts/profiles.ts";
import { Failure } from "../components/common.tsx";
/** Disabled profiles retain history; definition evaluation and new starts stay off. */
export function AppResources({
  context,
  view,
  editable,
}: {
  readonly context: AccountContext;
  readonly view: "workflows" | "webhooks";
  readonly editable: boolean;
}) {
  const key = { app: context.app.id, profile: context.profile?.id };
  if (view === "workflows") {
    const bindings = workflowBindings({
      ...key,
      accounts: JSON.stringify(context.accounts),
      deployment: context.app.activeDeployment ?? undefined,
      expectedProfileRevision: context.profile?.revision,
    });
    return (
      <AppWorkflows
        key={`${context.app.activeDeployment}:${context.profile?.revision}`}
        app={context.app}
        bindings={bindings}
        enabled={context.profile?.enabled !== false}
        start={(definition, onStarted) => (
          <WorkflowStart
            key={definition.name}
            definition={definition}
            start={bindings.start(definition.name)}
            editable={editable}
            onStarted={onStarted}
            Failure={Failure}
          />
        )}
        runAction={(run, workflow, cursor) => (
          <WorkflowTerminate
            run={run}
            terminate={bindings.terminate(run.id, workflow, cursor)}
            editable={editable}
            Failure={Failure}
          />
        )}
        Failure={Failure}
      />
    );
  }
  const hooks = webhookBindings(key);
  const selected = context.profile;
  return (
    <AppWebhooks
      query={hooks.query}
      retry={hooks.retry}
      Failure={Failure}
      setupLink={(hook) => (
        <Button size="sm" variant="outline" asChild>
          <a href={`/webhooks/${context.app.id}/${hook.id}`}>
            {hook.status === "disabled" ? "Finish removal" : "Complete setup"}
          </a>
        </Button>
      )}
    >
      {selected && (
        <>
          <ProfileStatus
            profile={selected}
            retry={profileMutations({ ...key, profile: selected.id }).reconcile}
            Failure={Failure}
          />
          {editable && (
            <WebhookConfiguration
              profile={selected}
              update={profileMutations({ ...key, profile: selected.id }).update}
              Failure={Failure}
            />
          )}
        </>
      )}
    </AppWebhooks>
  );
}
