import { Effect } from "effect";
import { inject } from "vitest";

export interface ReleaseNetwork {
  readonly name: string;
}
export interface ReleaseSubnet extends ReleaseNetwork {
  readonly subnet: string;
}

export interface ReleaseNetworks {
  readonly catalog: ReleaseSubnet;
  readonly proxies: ReleaseNetwork;
  readonly tailnet: ReleaseSubnet;
}

declare module "vitest" {
  export interface ProvidedContext {
    releaseNetworks: ReleaseNetworks;
  }
}

export const releaseNetwork = <const Scenario extends keyof ReleaseNetworks>(scenario: Scenario) =>
  Effect.sync(() => inject("releaseNetworks")).pipe(
    Effect.flatMap((networks) =>
      networks === undefined
        ? Effect.die(
            "The released-image networks are missing: run these scenarios with e2e/docker-release.config.ts",
          )
        : Effect.succeed<ReleaseNetworks[Scenario]>(networks[scenario]),
    ),
  );
