/** Concurrent permission reads share the same independently created requests within one dialog. */
import { Effect, Semaphore } from "effect";
import type { AccountConnection } from "@executor-js/sdk";
import type { IdentityAppTarget, IdentityConsentSelection } from "./identity-consent.ts";

type Target = Omit<IdentityAppTarget, "method">;
export const identityRequests = <E, R>(
  primary: Target,
  create: (target: Target) => Effect.Effect<AccountConnection, E, R>,
) => {
  const lock = Semaphore.makeUnsafe(1);
  const requests = new Map<string, AccountConnection>();
  const request = (target: Target) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const key = JSON.stringify([target.app, target.scope, target.requirement]);
        const existing = requests.get(key);
        if (existing !== undefined) return existing;
        const saved = yield* create(target);
        requests.set(key, saved);
        return saved;
      }),
    );
  return (selection: IdentityConsentSelection) =>
    Effect.gen(function* () {
      const connection = yield* request(primary);
      const additionalConnections = yield* Effect.forEach(
        selection.additionalTargets ?? [],
        (target) =>
          Effect.map(request(target), (saved) => ({ connection: saved.id, method: target.method })),
      );
      return {
        connection: connection.id,
        additionalConnections,
        sourceAccount: selection.sourceAccount ?? null,
      };
    });
};
