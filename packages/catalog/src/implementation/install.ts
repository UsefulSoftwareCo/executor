import { Effect } from "effect";
import type { App, DeployedApp } from "@executor-js/sdk";

export const deployedCopy = ({ activeVersion, ...app }: App): Effect.Effect<DeployedApp> =>
  activeVersion === null
    ? Effect.die(new Error("A deployed copy has no active version"))
    : Effect.succeed({ ...app, activeVersion });
