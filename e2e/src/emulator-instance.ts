// Per-scenario service emulators, spawned IN THIS PROCESS.
//
// These used to be hosted instances created through
// `https://<service>.emulators.dev/_emulate/instances`. That put the public
// internet on the critical path of a scenario that is otherwise entirely
// local, and it showed: in the two weeks to 2026-08-20, `connect ETIMEDOUT`
// and bare 502s reaching the edge failed 17 shards. Worse, by 2026-08-20
// `graphql-introspection-health` failed on every CI run because the hosted
// GitHub emulator answered `403 API rate limit exceeded` — GitHub's real
// unauthenticated-rate-limit shape — instead of the 401 the scenario had
// armed a fault for. Raising the fault budget from 10 to 100 changed nothing,
// so whatever produced that 403 sat outside the instance's own fault
// accounting; from a shared CI egress IP there is no version of the scenario
// that can stay under it.
//
// `@executor-js/emulate` describes itself as "local drop-in replacement
// services for CI and no-network sandboxes", and the suite already boots
// WorkOS and Autumn this way in `setup/cloud.boot.ts`. This is the same thing
// per scenario: same package, same wire behaviour, same per-run isolation (a
// fresh process-local instance, so ledger assertions stay clean), minus the
// network. The app under test reaches it over loopback, which cloud already
// allows for the WorkOS and Autumn emulators (`ALLOW_LOCAL_NETWORK`).
import { createServer } from "node:net";

import { Effect, Schedule, type Scope } from "effect";

import { createEmulator, type ServiceName } from "@executor-js/emulate";

/** The emulator could not be started, or never answered its control plane. */
export class EmulatorInstanceError extends Error {
  readonly _tag = "EmulatorInstanceError";

  constructor(
    readonly service: string,
    readonly reason: string,
  ) {
    super(`${service} emulator did not start: ${reason}`);
    this.name = "EmulatorInstanceError";
  }
}

// Ask the OS for a port and hand it straight to the emulator. There is a
// window between the probe closing and the emulator binding, which is why
// `spawnEmulator` retries: on Linux CI this whole range is ephemeral, so an
// outbound socket really can take the port in between (the same race
// `src/ports.ts` documents for the target's own stack).
const freePort = (): Promise<number | null> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(null));
    probe.listen(0, "0.0.0.0", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port === 0 ? null : port));
    });
  });

const READY_TIMEOUT = "10 seconds";

const spawnEmulator = (service: ServiceName, label: string) =>
  Effect.gen(function* () {
    const port = yield* Effect.promise(freePort).pipe(
      Effect.flatMap((found) =>
        found === null
          ? Effect.fail(new EmulatorInstanceError(service, "the OS offered no free port"))
          : Effect.succeed(found),
      ),
    );
    // 127.0.0.1, not localhost: the emulator stamps this base URL into its own
    // OAuth metadata and discovery documents, and `localhost` resolves to ::1
    // first on some hosts. Pinning the family keeps what the app is told
    // byte-identical to what the emulator is listening on.
    const baseUrl = `http://127.0.0.1:${port}`;
    const emulator = yield* Effect.tryPromise({
      try: () => createEmulator({ service, port, baseUrl }),
      catch: (cause) => new EmulatorInstanceError(service, String(cause)),
    });
    // `createEmulator` returns as soon as the server is handed off, so prove
    // the control plane answers before a scenario arms a fault against it.
    yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${baseUrl}/_emulate/manifest`);
        if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
      },
      catch: (cause) => new EmulatorInstanceError(service, String(cause)),
    }).pipe(
      Effect.retry(Schedule.both(Schedule.spaced("100 millis"), Schedule.recurs(50))),
      Effect.timeoutOrElse({
        duration: READY_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new EmulatorInstanceError(service, `control plane silent for ${READY_TIMEOUT}`),
          ),
      }),
      // The half-started server must not outlive the failure.
      Effect.tapError(() => Effect.promise(() => emulator.close())),
    );
    yield* Effect.logDebug(`[e2e] ${label} ${service} emulator at ${baseUrl}`);
    return emulator;
  });

/**
 * Start a `service` emulator for the calling scenario and return its base URL.
 *
 * Scoped: the emulator is closed when the scenario's scope closes, so wrap the
 * body in `Effect.scoped`. `label` names the instance in debug output.
 */
export const createEmulatorInstance = (
  service: ServiceName,
  label = "e2e",
): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    spawnEmulator(service, label).pipe(
      // A port lost between probe and bind is worth one more try; anything
      // else is a defect in the run, not a product failure the scenario
      // should be asked to model.
      Effect.retry(Schedule.both(Schedule.spaced("200 millis"), Schedule.recurs(2))),
      Effect.orDie,
    ),
    (emulator) => Effect.promise(() => emulator.close()),
  ).pipe(Effect.map((emulator) => emulator.url));
