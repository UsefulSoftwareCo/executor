/**
 * An app page discovers its tools, skills, workflows, schedules and webhooks with the app's linked
 * accounts, in one cache per app and deployment. The caller's own link, unlink or connection reads
 * it again; the page's normal refresh covers the rest.
 */
import type { App, AppId, DeploymentId } from "@executor-js/sdk";
import type { Atom } from "effect/reactivity";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { toolsAtom } from "./apps.ts";
import { refreshSkillDiscovery } from "./app-browser.ts";
import { refreshResourceDiscovery } from "./resources.ts";
import { refreshScheduleDiscovery } from "./schedules.ts";

/** The app and deployment whose discovery a page shows. */
export interface DiscoveryTarget {
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly deployment: DeploymentId | null;
}

export const discoveryTarget = (
  organization: OrganizationReference,
  app: App,
): DiscoveryTarget => ({
  organization,
  app: app.id,
  deployment: app.activeDeployment,
});

export const refreshAppDiscovery = (get: Atom.FnContext, target: DiscoveryTarget) => {
  const deployment = target.deployment ?? undefined;
  get.refresh(toolsAtom({ organization: target.organization, app: target.app, deployment }));
  refreshSkillDiscovery(get, target);
  refreshResourceDiscovery(get, {
    organization: target.organization,
    app: target.app,
    deployment,
  });
  refreshScheduleDiscovery(get, target);
};
