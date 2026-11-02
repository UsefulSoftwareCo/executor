import { Clock, Effect, Redacted, Schema, type Crypto } from "effect";
import { HostOperationFailed, HostOperationNotFound } from "apps/contracts";
import type {
  AccountAcquisitionAccountContext,
  AccountAcquisitionContext,
  AccountAcquisitionRegistration,
} from "../contracts/account-acquisition-driver.ts";
import type { Credentials } from "../contracts/storage.ts";
import { StorageError, type AccountId, type OwnerId } from "../contracts/shared.ts";
import { transaction, type Query } from "./database.ts";
import {
  requireAcquisitionBinding,
  resolveAcquisitionBinding,
} from "./account-acquisition-bindings.ts";
import type { AcquisitionRegistry } from "./account-acquisition-registry.ts";
import { acquisitionCallbackError, acquisitionCheckOutput } from "./account-acquisition-output.ts";

type ContextInput = Omit<AccountAcquisitionContext, "signal" | "fetch">;

/** The enclosing effect owns cancellation, including host-supplied fetches inside Promise adapters. */
export const invokeAcquisitionDriver = <A, E>(
  registration: AccountAcquisitionRegistration,
  input: ContextInput,
  invoke: (context: AccountAcquisitionContext) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const remaining = input.deadline - (yield* Clock.currentTimeMillis);
    if (remaining <= 0) return yield* Effect.fail(new HostOperationFailed({}));
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        invoke({ ...input, signal: controller.signal, fetch: registration.fetch }).pipe(
          Effect.mapError((error) =>
            Schema.is(HostOperationNotFound)(error) ? new HostOperationFailed({}) : error,
          ),
        ),
      (controller) => Effect.sync(() => controller.abort()),
    ).pipe(Effect.timeout(remaining));
  });

export const makeAcquisitionRuntime = (
  db: Query,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  registry: AcquisitionRegistry,
) => {
  const resolve = resolveAcquisitionBinding(db, credentials);
  return {
    resolve,
    source: (input: { readonly account: AccountId; readonly owner?: OwnerId }) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(input);
        if (resolved === undefined) return undefined;
        const registration = yield* registry.retained(resolved.binding);
        const context = {
          owner: resolved.binding.owner,
          provider: resolved.binding.provider,
          method: resolved.binding.method,
        };
        const call = <A>(
          hook: (context: AccountAcquisitionAccountContext) => Effect.Effect<A, unknown>,
        ) =>
          Effect.gen(function* () {
            yield* transaction(db, (tx) => requireAcquisitionBinding(tx, resolved.binding));
            const operation = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(() => new StorageError()),
            );
            return yield* invokeAcquisitionDriver(
              registration,
              { ...context, operation, deadline: (yield* Clock.currentTimeMillis) + 15_000 },
              (current) =>
                hook({
                  ...current,
                  binding: resolved.binding,
                  reference: resolved.reference,
                }).pipe(
                  Effect.mapError((error) =>
                    acquisitionCallbackError(
                      error,
                      resolved.binding.account,
                      Redacted.value(resolved.reference),
                    ),
                  ),
                ),
            );
          });
        const { driver } = registration;
        const check = driver.check;
        return {
          binding: resolved.binding,
          source: {
            kind: "driver" as const,
            id: driver.id,
            version: driver.revision,
          },
          current: requireAcquisitionBinding(db, resolved.binding),
          ...(check === undefined
            ? {}
            : {
                check: () =>
                  call(check).pipe(
                    Effect.flatMap((value) =>
                      acquisitionCheckOutput(value, Redacted.value(resolved.reference)),
                    ),
                  ),
              }),
        };
      }),
  };
};
