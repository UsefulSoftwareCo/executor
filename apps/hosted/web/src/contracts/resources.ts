/** Independent resource queries and mutations retain the account and deployment that opened them. */
import { Data, Effect } from "effect";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import {
  WorkflowRunId,
  type AppId,
  type DeploymentId,
  type ProfileId,
  type Json,
  type WebhookId,
} from "@executor-js/sdk";
import { acknowledge } from "@executor-js/ui/contracts/mutations";
import { pollingQuery } from "@executor-js/ui/contracts/polling";
import { HostedClient } from "./api.ts";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { protectedQuery } from "./protected-query.ts";

class Target extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly profile?: ProfileId | undefined;
}> {}
class DefinitionKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly profile?: ProfileId | undefined;
  readonly deployment?: DeploymentId | undefined;
  readonly expectedProfileRevision?: number | undefined;
  readonly accounts?: string | undefined;
}> {}
class StartKey extends Data.Class<{ readonly target: DefinitionKey; readonly workflow: string }> {}
class PageKey extends Data.Class<{
  readonly target: Target;
  readonly cursor?: WorkflowRunId | undefined;
  readonly workflow?: string | undefined;
}> {}
class RunKey extends Data.Class<{ readonly page: PageKey; readonly run: WorkflowRunId }> {}
class HookKey extends Data.Class<{ readonly target: Target; readonly subscription: WebhookId }> {}
const definitions = Atom.family((key: DefinitionKey) =>
  HostedClient.query("workflows", "definitions", {
    params: key,
    query: {
      profile: key.profile,
      deployment: key.deployment,
      expectedProfileRevision: key.expectedProfileRevision,
    },
  }).pipe(Atom.refreshOnWindowFocus, protectedQuery),
);
const runsSource = Atom.family((key: PageKey) =>
  HostedClient.query("workflows", "list", {
    params: key.target,
    query: {
      profile: key.target.profile,
      limit: 20,
      cursor: key.cursor,
      workflow: key.workflow,
    },
  }).pipe(Atom.refreshOnWindowFocus, protectedQuery),
);
const runs = Atom.family((key: PageKey) =>
  pollingQuery(
    Atom.map(
      runsSource(key),
      AsyncResult.map((page) => ({
        ...page,
        items: page.items.filter((run) => run.profile === key.target.profile),
      })),
    ),
  ),
);
const starts = Atom.family((start: StartKey) => {
  const key = start.target;
  return HostedClient.runtime.fn(
    (input: { readonly workflow: string; readonly input: Json; readonly key: string }, get) =>
      Effect.flatMap(HostedClient, (client) =>
        client.workflows.start({
          params: key,
          payload: {
            ...input,
            profile: key.profile,
            deployment: key.deployment,
            expectedProfileRevision: key.expectedProfileRevision,
          },
        }),
      ).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            const page = new PageKey({
              target: new Target({
                organization: key.organization,
                app: key.app,
                profile: key.profile,
              }),
            });
            for (const workflow of [undefined, saved.workflow])
              acknowledge(
                get,
                runsSource(new PageKey({ target: page.target, workflow })),
                (current) => ({
                  ...current,
                  items: [saved, ...current.items.filter((run) => run.id !== saved.id)].slice(
                    0,
                    20,
                  ),
                }),
              );
          }),
        ),
      ),
  );
});
const terminate = Atom.family((key: RunKey) =>
  HostedClient.runtime.fn((_: void, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.workflows.terminate({ params: { ...key.page.target, run: key.run } }),
    ).pipe(
      Effect.tap((saved) =>
        Effect.sync(() =>
          acknowledge(get, runsSource(key.page), (page) => ({
            ...page,
            items: page.items.map((run) => (run.id === saved.id ? saved : run)),
          })),
        ),
      ),
    ),
  ),
);
/** Current definitions are independent of retained, paginated run history. */
export const workflowBindings = (input: ConstructorParameters<typeof DefinitionKey>[0]) => {
  const key = new DefinitionKey(input);
  const target = new Target({
    organization: key.organization,
    app: key.app,
    profile: key.profile,
  });
  return {
    workflows: definitions(key),
    start: (workflow: string) => starts(new StartKey({ target: key, workflow })),
    runs: (workflow: string | undefined, cursor: WorkflowRunId | undefined) =>
      runs(new PageKey({ target, cursor, workflow })),
    terminate: (
      run: WorkflowRunId,
      workflow: string | undefined,
      cursor: WorkflowRunId | undefined,
    ) => terminate(new RunKey({ page: new PageKey({ target, cursor, workflow }), run })),
  };
};
const hooksSource = Atom.family((key: Target) =>
  HostedClient.query("webhooks", "list", {
    params: key,
    query: { profile: key.profile },
  }).pipe(Atom.refreshOnWindowFocus, protectedQuery),
);
const hooks = Atom.family((key: Target) =>
  pollingQuery(
    Atom.map(
      hooksSource(key),
      AsyncResult.map((rows) => rows.filter((hook) => (hook.profile ?? undefined) === key.profile)),
    ),
  ),
);
const reconcile = Atom.family((key: HookKey) =>
  HostedClient.runtime.fn((_: void, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.webhooks.reconcile({ params: { ...key.target, subscription: key.subscription } }),
    ).pipe(
      Effect.tap((saved) =>
        Effect.sync(() =>
          acknowledge(get, hooksSource(key.target), (rows) =>
            rows.map((row) => (row.id === saved.id ? saved : row)),
          ),
        ),
      ),
    ),
  ),
);
/** History is scoped explicitly, including the app-owned group with no profile. */
export const webhookBindings = (input: ConstructorParameters<typeof Target>[0]) => {
  const target = new Target(input);
  return {
    query: hooks(target),
    retry: (subscription: WebhookId) => reconcile(new HookKey({ target, subscription })),
  };
};
