import { workflowBindings } from "./resources.ts";
import type { DashboardError } from "./errors.ts";
import type { SkillBindings, WorkflowBindings } from "@executor-js/ui/contracts/app-browser";
/** Deployment and account identities invalidate discovery without freezing dynamic catalogs. */
import type { App, AppId, DeploymentId, Profile } from "@executor-js/sdk";
import { Cause, Data, Match, Option } from "effect";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
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
/** Product-owned query bindings share stable identities between overview and detail sections. */
export function appBrowserBindings(
  app: App,
  profile?: Profile,
): SkillBindings<DashboardError> & WorkflowBindings<DashboardError> {
  const key = new AppKey({
    app: app.id,
    deployment: app.activeDeployment,
  });
  return {
    skills: skills(key),
    ...workflowBindings({
      app: app.id,
      accounts: JSON.stringify(profile?.accounts ?? {}),
      deployment: app.activeDeployment ?? undefined,
      profile: profile?.id,
      expectedProfileRevision: profile?.revision,
    }),
    bundle: bundle(key),
  };
}
