import type { App, AppId, VersionId } from "@executor-js/sdk";
import type { Atom } from "effect/reactivity";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { toolsAtom } from "./apps.ts";
import { refreshSkillDiscovery } from "./app-browser.ts";
import { refreshResourceDiscovery } from "./resources.ts";
import { refreshScheduleDiscovery } from "./schedules.ts";

export interface DiscoveryTarget {
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly version: VersionId | null;
}

export const discoveryTarget = (
  organization: OrganizationReference,
  app: App,
): DiscoveryTarget => ({
  organization,
  app: app.id,
  version: app.activeVersion,
});

export const refreshAppDiscovery = (get: Atom.FnContext, target: DiscoveryTarget) => {
  const version = target.version ?? undefined;
  get.refresh(toolsAtom({ organization: target.organization, app: target.app, version }));
  refreshSkillDiscovery(get, target);
  refreshResourceDiscovery(get, {
    organization: target.organization,
    app: target.app,
    version,
  });
  refreshScheduleDiscovery(get, target);
};
