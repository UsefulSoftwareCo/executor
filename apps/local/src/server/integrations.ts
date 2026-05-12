import { Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { NodeFileSystem } from "@effect/platform-node";

import {
  IntegrationsRegistry,
  integrationsRegistryLayer,
} from "@executor-js/integrations-registry";

import { USER_AGENT } from "./installation";

// Module-singleton runtime for the integrations.sh registry. The layer's
// scoped fork fetches the registry at startup and refreshes on a 12-hour
// cadence for the runtime's lifetime. Shared across every long-running
// apps/local surface (HTTP server, stdio MCP) so concurrent surfaces don't
// each spin up their own refresh fork.
const integrationsRuntime = ManagedRuntime.make(
  integrationsRegistryLayer({ userAgent: USER_AGENT }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeFileSystem.layer),
  ),
);

/**
 * Idempotently trigger the registry layer to build, which forks the boot
 * fetch and recurring refresh into the runtime's scope. Fire-and-forget:
 * returns immediately, never throws, never blocks the caller. Failures are
 * absorbed inside the forked fiber and the layer's catchCause handlers.
 */
export const startIntegrationsRefresh = (): void => {
  integrationsRuntime.runFork(IntegrationsRegistry.asEffect());
};
