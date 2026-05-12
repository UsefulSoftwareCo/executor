import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { BunFileSystem } from "@effect/platform-bun";

import {
  IntegrationsRegistry,
  integrationsRegistryLayer,
} from "@executor-js/integrations-registry";

import { USER_AGENT } from "./installation";

const refreshRegistry = IntegrationsRegistry.asEffect().pipe(
  Effect.flatMap((service) => service.refresh()),
  Effect.asVoid,
);

// Trigger a TTL-gated registry refresh on a sidecar runtime. Fire-and-forget:
// returns immediately, never throws, never blocks the caller. Bun's event
// loop stays alive while the request is in flight, so sub-second CLI commands
// still complete the fetch before process exit; long-lived commands (e.g.
// `executor mcp`) get their recurring refresh from apps/local instead.
// Honors DO_NOT_TRACK and EXECUTOR_DISABLE_INTEGRATIONS_FETCH inside the
// layer.
export const fetchIntegrations = (): void => {
  const runtime = ManagedRuntime.make(
    integrationsRegistryLayer({ userAgent: USER_AGENT, recurring: false }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(BunFileSystem.layer),
    ),
  );
  runtime.runFork(
    Effect.ensuring(
      refreshRegistry,
      Effect.promise(() => runtime.dispose()),
    ),
  );
};
