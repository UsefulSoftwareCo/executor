import type { HostedError } from "./errors.ts";
import type { SkillBindings, WorkflowBindings } from "@executor-js/ui/contracts/app-browser";
/** Deployment and account identities invalidate discovery without freezing dynamic catalogs. */
import type { App, AppId, DeploymentId, WorkflowRunId } from "@executor-js/sdk";
import { Data, Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { pollingQuery } from "@executor-js/ui/contracts/polling";
import { HostedClient } from "./api.ts";
import { protectedQuery } from "./protected-query.ts";
import { currentQuery } from "@executor-js/ui/contracts/mutations";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";

class AppKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly deployment: DeploymentId | null;
  readonly accounts: string;
}> {}
class RunsKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly workflow: string | undefined;
  readonly cursor: WorkflowRunId | undefined;
}> {}
const skills = Atom.family((key: AppKey) =>
  HostedClient.query("skills", "list", {
    params: { organization: key.organization, app: key.app },
    query: key.deployment === null ? {} : { deployment: key.deployment },
  }).pipe(Atom.refreshOnWindowFocus, protectedQuery),
);
const bundle = Atom.family((key: AppKey) =>
  HostedClient.query("skills", "bundle", {
    params: { organization: key.organization, app: key.app },
    query: key.deployment === null ? {} : { deployment: key.deployment },
  }).pipe(Atom.refreshOnWindowFocus, protectedQuery),
);
const workflows = Atom.family((key: AppKey) =>
  HostedClient.runtime
    .atom(
      Effect.flatMap(HostedClient, (client) =>
        client.workflows.definitions({
          params: { organization: key.organization, app: key.app },
        }),
      ),
    )
    .pipe(Atom.refreshOnWindowFocus, protectedQuery),
);
const runs = Atom.family((key: RunsKey) =>
  HostedClient.query("workflows", "list", {
    params: { organization: key.organization, app: key.app },
    query: {
      limit: 20,
      ...(key.workflow === undefined ? {} : { workflow: key.workflow }),
      ...(key.cursor === undefined ? {} : { cursor: key.cursor }),
    },
  }).pipe(Atom.refreshOnWindowFocus, protectedQuery, pollingQuery),
);
const catalog = Atom.family((key: AppKey) =>
  HostedClient.runtime
    .atom(
      Effect.flatMap(HostedClient, (client) =>
        client.tools.list({
          params: { organization: key.organization, app: key.app },
          query: {},
        }),
      ),
    )
    .pipe(Atom.refreshOnWindowFocus, currentQuery),
);
/** Product-owned query bindings share stable identities between overview and detail sections. */
export function appBrowserBindings(
  organization: OrganizationReference,
  app: App,
): SkillBindings<HostedError> & WorkflowBindings<HostedError> {
  const key = new AppKey({
    organization,
    app: app.id,
    deployment: app.activeDeployment,
    accounts: JSON.stringify(app.accounts),
  });
  return {
    skills: skills(key),
    workflows: workflows(key),
    bundle: bundle(key),
    runs: (workflow: string | undefined, cursor: WorkflowRunId | undefined) =>
      runs(new RunsKey({ organization, app: app.id, workflow, cursor })),
  };
}

/** Each account selection starts a fresh catalog read; previous selections cannot supply its display data. */
export const appToolsCatalog = (organization: OrganizationReference, app: App) =>
  catalog(
    new AppKey({
      organization,
      app: app.id,
      deployment: app.activeDeployment,
      accounts: JSON.stringify(app.accounts),
    }),
  );
