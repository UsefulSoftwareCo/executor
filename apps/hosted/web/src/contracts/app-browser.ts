import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { workflowBindings } from "./resources.ts";
import type { HostedError } from "./errors.ts";
import type { SkillBindings, WorkflowBindings } from "@executor-js/ui/contracts/app-browser";
import type { App, AppId, VersionId } from "@executor-js/sdk";
import { Data } from "effect";
import { Atom } from "effect/reactivity";
import { HostedClient } from "./api.ts";
import { protectedQuery } from "./protected-query.ts";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";

class AppKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly version: VersionId | null;
}> {}
const query = (key: AppKey) => ({ version: key.version ?? undefined });
const skills = Atom.family((key: AppKey) =>
  HostedClient.query(
    "skills",
    "list",
    hydrated({
      params: { organization: key.organization, app: key.app },
      query: query(key),
    }),
  ).pipe(revalidated, protectedQuery),
);
const bundle = Atom.family((key: AppKey) =>
  HostedClient.query(
    "skills",
    "bundle",
    hydrated({
      params: { organization: key.organization, app: key.app },
      query: query(key),
    }),
  ).pipe(revalidated, protectedQuery),
);
export function appBrowserBindings(
  organization: OrganizationReference,
  app: App,
): SkillBindings<HostedError> & WorkflowBindings<HostedError> {
  const key = new AppKey({ organization, app: app.id, version: app.activeVersion });
  return {
    skills: skills(key),
    ...workflowBindings({
      organization,
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
