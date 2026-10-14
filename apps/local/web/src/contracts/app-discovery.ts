/**
 * An app page discovers its tools, skills, workflows, schedules and webhooks with the app's linked
 * accounts, in one cache per app and deployment. Linking, unlinking or connecting an account reads
 * it again; the page's normal refresh covers the rest.
 */
import type { AppId, DeploymentId } from "@executor-js/sdk";
import type { Atom } from "effect/reactivity";
import { toolsAtom } from "./api.ts";
import { refreshSkillDiscovery } from "./app-browser.ts";
import { refreshResourceDiscovery } from "./resources.ts";
import { refreshScheduleDiscovery } from "./schedules.ts";

/** The app and deployment whose discovery a page shows. */
export interface DiscoveryTarget {
  readonly app: AppId;
  readonly deployment: DeploymentId | null;
}

export const refreshAppDiscovery = (get: Atom.FnContext, target: DiscoveryTarget) => {
  get.refresh(toolsAtom({ app: target.app, deployment: target.deployment }));
  refreshSkillDiscovery(get, target);
  refreshResourceDiscovery(get, {
    app: target.app,
    deployment: target.deployment ?? undefined,
  });
  refreshScheduleDiscovery(get, target.app);
};
