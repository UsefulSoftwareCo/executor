/** Independent resource queries and mutations retain the accounts and deployment that opened them. */
import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { Data, Effect } from "effect";
import { Atom } from "effect/reactivity";
import {
  WorkflowRunId,
  type AppId,
  type DeploymentId,
  type AccountId,
  type Json,
  type WebhookId,
  type ConfigureWebhookSource,
} from "@executor-js/sdk";
import { acknowledge } from "@executor-js/ui/contracts/mutations";
import { pollingQuery, unsettledRuns, unsettledWebhooks } from "@executor-js/ui/contracts/polling";
import { HostedClient } from "./api.ts";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { protectedQuery } from "./protected-query.ts";

class Target extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
}> {}
class DefinitionKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly deployment?: DeploymentId | undefined;
}> {}
class StartKey extends Data.Class<{ readonly target: DefinitionKey; readonly workflow: string }> {}
class PageKey extends Data.Class<{
  readonly target: Target;
  readonly cursor?: WorkflowRunId | undefined;
  readonly workflow?: string | undefined;
}> {}
class RunKey extends Data.Class<{ readonly page: PageKey; readonly run: WorkflowRunId }> {}
class HookKey extends Data.Class<{ readonly target: Target; readonly subscription: WebhookId }> {}
class SourceKey extends Data.Class<{ readonly target: Target; readonly account: AccountId }> {}
const definitions = Atom.family((key: DefinitionKey) =>
  HostedClient.query(
    "workflows",
    "definitions",
    hydrated({
      params: key,
      query: { deployment: key.deployment },
    }),
  ).pipe(revalidated, protectedQuery),
);
const runsSource = Atom.family((key: PageKey) =>
  HostedClient.query(
    "workflows",
    "list",
    hydrated({
      params: key.target,
      query: {
        limit: 20,
        cursor: key.cursor,
        workflow: key.workflow,
      },
    }),
  ).pipe(revalidated, protectedQuery),
);
const runs = Atom.family((key: PageKey) =>
  pollingQuery(runsSource(key), { active: unsettledRuns }),
);
const starts = Atom.family((start: StartKey) => {
  const key = start.target;
  return HostedClient.runtime.fn(
    (input: { readonly workflow: string; readonly input: Json; readonly key: string }, get) =>
      Effect.flatMap(HostedClient, (client) =>
        client.workflows.start({
          params: key,
          payload: { ...input, deployment: key.deployment },
        }),
      ).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            const page = new PageKey({
              target: new Target({ organization: key.organization, app: key.app }),
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
/**
 * Read the app's workflow definitions and webhooks again, as after the caller links or unlinks an
 * account: both are discovered with the app's linked accounts.
 */
export const refreshResourceDiscovery = (
  get: Atom.FnContext,
  key: ConstructorParameters<typeof DefinitionKey>[0],
) => {
  get.refresh(definitions(new DefinitionKey(key)));
  const target = new Target({ organization: key.organization, app: key.app });
  get.refresh(hooksSource(target));
  get.refresh(sourcesSource(target));
};
/** Current definitions are independent of retained, paginated run history. */
export const workflowBindings = (input: ConstructorParameters<typeof DefinitionKey>[0]) => {
  const key = new DefinitionKey(input);
  const target = new Target({ organization: key.organization, app: key.app });
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
  HostedClient.query("webhooks", "list", hydrated({ params: key })).pipe(
    revalidated,
    protectedQuery,
  ),
);
const hooks = Atom.family((key: Target) =>
  pollingQuery(hooksSource(key), { active: unsettledWebhooks }),
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
const sourcesSource = Atom.family((key: Target) =>
  HostedClient.query("webhooks", "sources", hydrated({ params: key })).pipe(
    revalidated,
    protectedQuery,
  ),
);
/** Saving keeps the listed label; the source's subscriptions are re-registered in the background. */
const configure = Atom.family((key: SourceKey) =>
  HostedClient.runtime.fn((input: typeof ConfigureWebhookSource.Type, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.webhooks.configureSource({
        params: { ...key.target, account: key.account },
        payload: input,
      }),
    ).pipe(
      Effect.tap((saved) =>
        Effect.sync(() => {
          acknowledge(get, sourcesSource(key.target), (rows) =>
            rows.map((row) => (row.account === saved.account ? { ...row, ...saved } : row)),
          );
          get.refresh(hooksSource(key.target));
        }),
      ),
    ),
  ),
);
/** Subscriptions of the app the caller can see; each runs as its own actor. */
export const webhookBindings = (input: ConstructorParameters<typeof Target>[0]) => {
  const target = new Target(input);
  return {
    query: hooks(target),
    retry: (subscription: WebhookId) => reconcile(new HookKey({ target, subscription })),
    sources: sourcesSource(target),
    configure: (account: AccountId) => configure(new SourceKey({ target, account })),
  };
};
