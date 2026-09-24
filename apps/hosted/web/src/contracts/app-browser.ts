import { workflowBindings } from "./resources.ts";
import type { HostedError } from "./errors.ts";
import type { SkillBindings, WorkflowBindings } from "@executor-js/ui/contracts/app-browser";
/** Deployment and account identities invalidate discovery without freezing dynamic catalogs. */
import type { App, AppId, DeploymentId, ProfileId, Profile } from "@executor-js/sdk";
import { Data } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { HostedClient } from "./api.ts";
import { protectedQuery } from "./protected-query.ts";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";

class AppKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly deployment: DeploymentId | null;
  readonly profile: ProfileId | undefined;
  readonly expectedProfileRevision: number | undefined;
}> {}
const skills = Atom.family((key: AppKey) =>
  HostedClient.query("skills", "list", {
    params: { organization: key.organization, app: key.app },
    query: {
      deployment: key.deployment ?? undefined,
      profile: key.profile,
      expectedProfileRevision: key.expectedProfileRevision,
    },
  }).pipe(Atom.refreshOnWindowFocus, protectedQuery),
);
const bundle = Atom.family((key: AppKey) =>
  HostedClient.query("skills", "bundle", {
    params: { organization: key.organization, app: key.app },
    query: {
      deployment: key.deployment ?? undefined,
      profile: key.profile,
      expectedProfileRevision: key.expectedProfileRevision,
    },
  }).pipe(Atom.refreshOnWindowFocus, protectedQuery),
);
/** Product-owned query bindings share stable identities between overview and detail sections. */
export function appBrowserBindings(
  organization: OrganizationReference,
  app: App,
  profile?: Profile,
): SkillBindings<HostedError> & WorkflowBindings<HostedError> {
  const key = new AppKey({
    organization,
    app: app.id,
    deployment: app.activeDeployment,
    profile: profile?.id,
    expectedProfileRevision: profile?.revision,
  });
  return {
    skills: skills(key),
    ...workflowBindings({
      organization,
      app: app.id,
      accounts: JSON.stringify(profile?.accounts ?? {}),
      deployment: app.activeDeployment ?? undefined,
      profile: profile?.id,
      expectedProfileRevision: profile?.revision,
    }),
    bundle: bundle(key),
  };
}
