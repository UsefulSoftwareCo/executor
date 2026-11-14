/**
 * The Docker networks the released-image scenarios run containers on, created once for the whole
 * suite by `docker-release-networks.ts`, its global setup, before any scenario starts.
 *
 * Creating or removing a Docker network adds or removes an address on the host, and Chromium then
 * aborts every request it has in flight with `ERR_NETWORK_CHANGED`. The suite's scenarios run in
 * parallel, so a scenario that made its own network aborted the page another scenario's browser
 * was loading: its scripts failed, the page kept the sign-in or setup form it was served with, and
 * the click on that form did nothing. Scenarios therefore create their containers as before but
 * never a network. Ask for a network here and add it to the global setup; do not run
 * `docker network` in a scenario.
 *
 * Starting or removing a container changes the host's addresses too, on Linux: the container's
 * link gains an IPv6 link-local address and then loses it. The release workflow turns IPv6 off
 * for new interfaces before the suite, with `sysctl -w net.ipv6.conf.default.disable_ipv6=1`.
 * A run on a Linux host without that setting can still stall a page this way.
 */
import { Effect } from "effect";
import { inject } from "vitest";

/** A network a scenario's containers join. */
export interface ReleaseNetwork {
  readonly name: string;
}
/** A network on a `/24` the scenario chose; `subnet` is its first three octets, such as `11.4.9`. */
export interface ReleaseSubnet extends ReleaseNetwork {
  readonly subnet: string;
}

/**
 * The scenarios that need their own network, each with the address space it tests: the catalog
 * feed's stand-in in public space, the trusted proxies on any subnet Docker picks, and the tailnet
 * origin in shared CGNAT space, the range Tailscale assigns.
 */
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

/** The suite's network for `scenario`. Only the released-image suite's global setup provides them. */
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
