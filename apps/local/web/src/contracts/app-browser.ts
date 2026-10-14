import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { workflowBindings } from "./resources.ts";
import type { DashboardError } from "./errors.ts";
import type { SkillBindings, WorkflowBindings } from "@executor-js/ui/contracts/app-browser";
/**
 * One discovery cache per app and deployment. Linking or unlinking an account reads it again, as
 * does the page's normal refresh.
 */
import type { App, AppId, DeploymentId } from "@executor-js/sdk";
import { Cause, Data, Match, Option } from "effect";
import { Atom, AsyncResult } from "effect/reactivity";
import { DashboardClient } from "./api.ts";
import { acknowledgedQuery } from "@executor-js/ui/contracts/mutations";

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
}> {}
const query = (key: AppKey) => ({ deployment: key.deployment ?? undefined });
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
/** Product-owned query bindings share stable identities between overview and detail sections. */
export function appBrowserBindings(
  app: App,
): SkillBindings<DashboardError> & WorkflowBindings<DashboardError> {
  const key = new AppKey({ app: app.id, deployment: app.activeDeployment });
  return {
    skills: skills(key),
    ...workflowBindings({
      app: app.id,
      deployment: app.activeDeployment ?? undefined,
    }),
    bundle: bundle(key),
  };
}
/** Read the app's skills again, as after linking or unlinking an account. */
export const refreshSkillDiscovery = (
  get: Atom.FnContext,
  key: ConstructorParameters<typeof AppKey>[0],
) => {
  get.refresh(skills(new AppKey(key)));
  get.refresh(bundle(new AppKey(key)));
};
