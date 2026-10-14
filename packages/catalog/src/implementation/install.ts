/** What a host's copy of an official app's prepared snapshot returns. */
import { Effect } from "effect";
import type { App, DeployedApp } from "@executor-js/sdk";

/**
 * `apps.copy` of a snapshot with `activation: "deploy"` deploys it and returns the deployed app;
 * its `App` type covers copies of unfinished apps too.
 */
export const deployedCopy = ({ activeDeployment, ...app }: App): Effect.Effect<DeployedApp> =>
  activeDeployment === null
    ? Effect.die(new Error("A deployed copy has no active deployment"))
    : Effect.succeed({ ...app, activeDeployment });
