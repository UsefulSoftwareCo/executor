import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { workflowBindings } from "./resources.ts";
import type { DashboardError } from "./errors.ts";
import type { SkillBindings, WorkflowBindings } from "@executor-js/ui/contracts/app-browser";
import type { App, AppId, VersionId } from "@executor-js/sdk";
import { Cause, Data, Match, Option } from "effect";
import { Atom, AsyncResult } from "effect/reactivity";
import { DashboardClient } from "./api.ts";
import { acknowledgedQuery } from "@executor-js/ui/contracts/mutations";

const denied = Match.type<DashboardError>().pipe(
  Match.tags({
    DashboardUnauthorized: () => true,
    DashboardForbidden: () => true,
    AppNotFound: () => true,
    AppSkillNotFound: () => true,
    VersionNotFound: () => true,
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
  readonly version: VersionId | null;
}> {}
const query = (key: AppKey) => ({ version: key.version ?? undefined });
const skills = Atom.family((key: AppKey) =>
  DashboardClient.query(
    "appBrowser",
    "skills",
    hydrated({
      params: { app: key.app },
      query: query(key),
    }),
  ).pipe(revalidated, protectedQuery),
);
const bundle = Atom.family((key: AppKey) =>
  DashboardClient.query(
    "appBrowser",
    "skillBundle",
    hydrated({
      params: { app: key.app },
      query: query(key),
    }),
  ).pipe(revalidated, protectedQuery),
);
export function appBrowserBindings(
  app: App,
): SkillBindings<DashboardError> & WorkflowBindings<DashboardError> {
  const key = new AppKey({ app: app.id, version: app.activeVersion });
  return {
    skills: skills(key),
    ...workflowBindings({
      app: app.id,
      version: app.activeVersion ?? undefined,
    }),
    bundle: bundle(key),
  };
}
export const refreshSkillDiscovery = (
  get: Atom.FnContext,
  key: ConstructorParameters<typeof AppKey>[0],
) => {
  get.refresh(skills(new AppKey(key)));
  get.refresh(bundle(new AppKey(key)));
};
