import type { DashboardError } from "./errors.ts";
import type { SkillBindings, WorkflowBindings } from "@executor-js/ui/contracts/app-browser";
/** Deployment and account identities invalidate discovery without freezing dynamic catalogs. */
import type { App, AppId, DeploymentId, WorkflowRunId } from "@executor-js/sdk";
import { Cause, Data, Effect, Match, Option } from "effect";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { pollingQuery } from "@executor-js/ui/contracts/polling";
import { DashboardClient, liveQueryAtom } from "./api.ts";
import { currentQuery, acknowledgedQuery } from "@executor-js/ui/contracts/mutations";

// Local sessions must also discard protected data after an authoritative denial.
const denied = Match.type<DashboardError>().pipe(
  Match.tags({
    DashboardUnauthorized: () => true,
    DashboardForbidden: () => true,
    AppNotFound: () => true,
    AppSkillNotFound: () => true,
    DeploymentNotFound: () => true,
  }),
  Match.orElse(() => false),
);
const protectedQuery = <A, E extends DashboardError>(
  source: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) =>
  acknowledgedQuery(source, (cause) => {
    const error = Cause.findErrorOption(cause);
    return Option.isNone(error) || !denied(error.value);
  });

class AppKey extends Data.Class<{
  readonly app: AppId;
  readonly deployment: DeploymentId | null;
  readonly accounts: string;
}> {}
class RunsKey extends Data.Class<{
  readonly app: AppId;
  readonly workflow: string | undefined;
  readonly cursor: WorkflowRunId | undefined;
}> {}
const skills = Atom.family((key: AppKey) =>
  DashboardClient.query("appBrowser", "skills", {
    params: { app: key.app },
    query: key.deployment === null ? {} : { deployment: key.deployment },
  }).pipe(Atom.refreshOnWindowFocus, protectedQuery),
);
const bundle = Atom.family((key: AppKey) =>
  DashboardClient.query("appBrowser", "skillBundle", {
    params: { app: key.app },
    query: key.deployment === null ? {} : { deployment: key.deployment },
  }).pipe(Atom.refreshOnWindowFocus, protectedQuery),
);
const workflows = Atom.family((key: AppKey) =>
  DashboardClient.runtime
    .atom(
      Effect.flatMap(DashboardClient, (client) =>
        client.appBrowser.workflows({
          params: { app: key.app },
        }),
      ),
    )
    .pipe(Atom.refreshOnWindowFocus, protectedQuery),
);
const runs = Atom.family((key: RunsKey) =>
  DashboardClient.query("appBrowser", "runs", {
    params: { app: key.app },
    query: {
      limit: 20,
      ...(key.workflow === undefined ? {} : { workflow: key.workflow }),
      ...(key.cursor === undefined ? {} : { cursor: key.cursor }),
    },
  }).pipe(Atom.refreshOnWindowFocus, protectedQuery, pollingQuery),
);
const catalog = Atom.family((key: AppKey) =>
  liveQueryAtom(
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.liveTools({
        params: { app: key.app },
        sseOptions: { maxEventSize: 16 * 1024 * 1024 },
      }),
    ),
  ).pipe(currentQuery, Atom.map(AsyncResult.map((value) => ({ items: value.tools })))),
);
/** Product-owned query bindings share stable identities between overview and detail sections. */
export function appBrowserBindings(
  app: App,
): SkillBindings<DashboardError> & WorkflowBindings<DashboardError> {
  const key = new AppKey({
    app: app.id,
    deployment: app.activeDeployment,
    accounts: JSON.stringify(app.accounts),
  });
  return {
    skills: skills(key),
    workflows: workflows(key),
    bundle: bundle(key),
    runs: (workflow: string | undefined, cursor: WorkflowRunId | undefined) =>
      runs(new RunsKey({ app: app.id, workflow, cursor })),
  };
}

/** Each account selection starts a fresh catalog read; previous selections cannot supply its display data. */
export const appToolsCatalog = (app: App) =>
  catalog(
    new AppKey({
      app: app.id,
      deployment: app.activeDeployment,
      accounts: JSON.stringify(app.accounts),
    }),
  );
