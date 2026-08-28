import { Effect, Schedule } from "effect";

/** The suite could not get an instance out of the hosted control plane. */
export class EmulatorInstanceError extends Error {
  readonly _tag = "EmulatorInstanceError";

  constructor(
    readonly service: string,
    readonly reason: string,
  ) {
    super(`${service} emulator instance creation failed: ${reason}`);
    this.name = "EmulatorInstanceError";
  }
}

// Bound each attempt: a hung connection to the edge must not eat the
// scenario's whole timeout before the first retry.
const ATTEMPT_TIMEOUT = "10 seconds";
const RETRIES = 3;

const requestInstance = (service: string, label: string) =>
  Effect.tryPromise({
    try: async (): Promise<string> => {
      const response = await fetch(`https://${service}.emulators.dev/_emulate/instances`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instance: label }),
      });
      if (!response.ok) {
        throw new EmulatorInstanceError(service, `HTTP ${response.status}`);
      }
      const instance = (await response.json()) as { readonly providerBaseUrl: string };
      return instance.providerBaseUrl;
    },
    catch: (cause) =>
      cause instanceof EmulatorInstanceError
        ? cause
        : new EmulatorInstanceError(service, String(cause)),
  });

// Hosted service hosts (e.g. resend.emulators.dev) are control plane only —
// there is no shared default instance behind them. Every scenario creates its
// own isolated instance and works against the returned providerBaseUrl, which
// also keeps ledger assertions free of cross-run pollution. The server
// generates an unguessable instance name; the label is a readable prefix.
//
// This is also the one request in a scenario that leaves the runner, so it is
// the one place where a CI runner's transient network trouble fails a scenario
// that has nothing to do with the network: `connect ETIMEDOUT` reaching the
// edge, plus the occasional bare 502, accounted for 17 shard failures in the
// two weeks to 2026-08-20. Asking for an instance is idempotent (a spare
// instance is nobody's business but the control plane's), so bound the attempt
// and retry with backoff. Nothing below this line retries anything the
// scenario is actually asserting on.
export const createEmulatorInstance = (service: string, label = "e2e"): Effect.Effect<string> =>
  requestInstance(service, label).pipe(
    Effect.timeoutOrElse({
      duration: ATTEMPT_TIMEOUT,
      orElse: () =>
        Effect.fail(new EmulatorInstanceError(service, `no response in ${ATTEMPT_TIMEOUT}`)),
    }),
    Effect.retry(
      Schedule.both(
        Schedule.exponential("500 millis").pipe(Schedule.jittered),
        Schedule.recurs(RETRIES),
      ),
    ),
    // An emulator the suite cannot reach at all is a defect in the run, not a
    // product failure the scenario should be asked to model.
    Effect.orDie,
  );
