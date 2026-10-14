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
import { acknowledge, acknowledgedQuery } from "@executor-js/ui/contracts/mutations";
import { pollingQuery, steadyPolling } from "@executor-js/ui/contracts/polling";
import { DashboardClient } from "./api.ts";

class Target extends Data.Class<{ readonly app: AppId }> {}
class DefinitionKey extends Data.Class<{
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
  DashboardClient.query(
    "workflows",
    "definitions",
    hydrated({
      params: { app: key.app },
      query: { deployment: key.deployment },
    }),
  ).pipe(revalidated, acknowledgedQuery),
);
const runsSource = Atom.family((key: PageKey) =>
  DashboardClient.query(
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
  ).pipe(revalidated, acknowledgedQuery),
);
const runs = Atom.family((key: PageKey) => pollingQuery(runsSource(key), steadyPolling));
const starts = Atom.family((start: StartKey) => {
  const key = start.target;
  return DashboardClient.runtime.fn(
    (input: { readonly workflow: string; readonly input: Json; readonly key: string }, get) =>
      Effect.flatMap(DashboardClient, (client) =>
        client.workflows.start({
          params: { app: key.app },
          payload: { ...input, deployment: key.deployment },
        }),
      ).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            const page = new PageKey({
              target: new Target({ app: key.app }),
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
  DashboardClient.runtime.fn((_: void, get) =>
    Effect.flatMap(DashboardClient, (client) =>
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
  const target = new Target({ app: key.app });
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
  DashboardClient.query("webhooks", "list", hydrated({ params: key })).pipe(
    revalidated,
    acknowledgedQuery,
  ),
);
const hooks = Atom.family((key: Target) => pollingQuery(hooksSource(key), steadyPolling));
const reconcile = Atom.family((key: HookKey) =>
  DashboardClient.runtime.fn((_: void, get) =>
    Effect.flatMap(DashboardClient, (client) =>
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
  DashboardClient.query("webhooks", "sources", hydrated({ params: key })).pipe(
    revalidated,
    acknowledgedQuery,
  ),
);
/** Saving keeps the listed label; the source's subscriptions are re-registered in the background. */
const configure = Atom.family((key: SourceKey) =>
  DashboardClient.runtime.fn((input: typeof ConfigureWebhookSource.Type, get) =>
    Effect.flatMap(DashboardClient, (client) =>
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
/** The app's webhook subscriptions; each runs as its own actor. */
/**
 * Read the app's workflow definitions and webhooks again, as after linking or unlinking an
 * account: both are discovered with the app's linked accounts.
 */
export const refreshResourceDiscovery = (
  get: Atom.FnContext,
  key: ConstructorParameters<typeof DefinitionKey>[0],
) => {
  get.refresh(definitions(new DefinitionKey(key)));
  get.refresh(hooksSource(new Target({ app: key.app })));
  get.refresh(sourcesSource(new Target({ app: key.app })));
};
export const webhookBindings = (input: ConstructorParameters<typeof Target>[0]) => {
  const target = new Target(input);
  return {
    query: hooks(target),
    retry: (subscription: WebhookId) => reconcile(new HookKey({ target, subscription })),
    sources: sourcesSource(target),
    configure: (account: AccountId) => configure(new SourceKey({ target, account })),
  };
};
