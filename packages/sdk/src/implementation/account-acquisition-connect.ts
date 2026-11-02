import { Clock, Effect, Redacted, Schema } from "effect";
import { InteractiveStart, type ConnectCommand } from "apps/contracts";
import { AccountAcquisitionUnavailable } from "../contracts/account-acquisition-driver.ts";
import type { InteractiveSession } from "../contracts/interactive-accounts.ts";
import type { Credentials } from "../contracts/storage.ts";
import type { Query } from "./database.ts";
import type { ConnectionRow } from "./connection-state.ts";
import type { AcquisitionRegistry } from "./account-acquisition-registry.ts";
import { resolveAcquisitionBinding } from "./account-acquisition-bindings.ts";
import { invokeAcquisitionDriver } from "./account-acquisition-runtime.ts";
import { acquisitionStartOutput, acquisitionStatusOutput } from "./account-acquisition-output.ts";
import { storedApp, storedVersion } from "./apps.ts";

/** App intent selects a provider/method; only the host registry selects its implementation. */
export const makeAcquisitionConnect = (
  db: Query,
  credentials: Credentials,
  registry: AcquisitionRegistry,
) => {
  const resolve = resolveAcquisitionBinding(db, credentials);
  const select = (row: ConnectionRow, method: string) =>
    Effect.gen(function* () {
      if (row.reconnectAccount !== null) {
        const saved = yield* resolve({ account: row.reconnectAccount, owner: row.owner });
        if (saved !== undefined) {
          const registration = yield* registry.retained(saved.binding);
          if (saved.binding.provider !== row.provider || saved.binding.method !== method)
            return yield* new AccountAcquisitionUnavailable({ reason: "binding" });
          return {
            id: registration.driver.id,
            revision: registration.driver.revision,
            generation: saved.binding.generation,
            bindingRevision: saved.binding.revision,
          } satisfies NonNullable<InteractiveSession["driver"]>;
        }
        return yield* new AccountAcquisitionUnavailable({ reason: "binding" });
      }
      const app = yield* storedApp(db, { app: row.target.app, owner: row.target.owner });
      const version = yield* storedVersion(db, app);
      if (!version.requirements.accounts[row.target.requirement]?.hostAcquisition?.includes(method))
        return undefined;
      const registration = registry.current(row.provider, method);
      if (registration === undefined)
        return yield* new AccountAcquisitionUnavailable({ reason: "registration" });
      return { id: registration.driver.id, revision: registration.driver.revision };
    });
  const prepare = (row: ConnectionRow, session: InteractiveSession) =>
    Effect.gen(function* () {
      const selected = session.driver;
      if (selected === undefined) return undefined;
      const registration = yield* registry.retained({
        driver: selected.id,
        driverRevision: selected.revision,
        provider: row.provider,
        method: session.method,
      });
      return (command: ConnectCommand) =>
        Effect.gen(function* () {
          const advancing =
            command.step === "start" || command.step === "status" || command.step === "submit";
          const saved =
            !advancing || row.reconnectAccount === null
              ? undefined
              : yield* resolve({ account: row.reconnectAccount, owner: row.owner });
          if (
            advancing &&
            row.reconnectAccount !== null &&
            (saved === undefined ||
              saved.binding.generation !== selected.generation ||
              saved.binding.revision !== selected.bindingRevision)
          )
            return yield* new AccountAcquisitionUnavailable({ reason: "changed" });
          const deadline = (yield* Clock.currentTimeMillis) + 15_000;
          const reference = saved === undefined ? undefined : Redacted.value(saved.reference);
          const statusOutput = (value: unknown) => acquisitionStatusOutput(value, reference);
          return yield* invokeAcquisitionDriver<unknown, unknown>(
            registration,
            {
              owner: row.owner,
              provider: row.provider,
              method: session.method,
              operation: `${row.id}:${session.running ?? "cancel"}:${command.step}`,
              deadline,
            },
            (context) => {
              const driver = registration.driver;
              switch (command.step) {
                case "start":
                  return driver
                    .start(
                      context,
                      saved === undefined
                        ? undefined
                        : {
                            ...context,
                            binding: saved.binding,
                            reference: saved.reference,
                          },
                    )
                    .pipe(
                      Effect.flatMap(Schema.decodeUnknownEffect(InteractiveStart)),
                      Effect.flatMap((started) =>
                        acquisitionStartOutput(started, reference).pipe(
                          Effect.onError(() =>
                            driver
                              .cancel(
                                {
                                  ...context,
                                  operation: `${row.id}:${session.running ?? "cancel"}:cancel`,
                                },
                                { session: started.session },
                              )
                              .pipe(
                                Effect.catch(() =>
                                  Effect.logWarning("Interactive sign-in cleanup did not finish"),
                                ),
                              ),
                          ),
                        ),
                      ),
                    );
                case "status":
                  return driver
                    .status(context, { session: command.input.session })
                    .pipe(Effect.flatMap(statusOutput));
                case "submit":
                  return driver.submit === undefined
                    ? Effect.fail(new AccountAcquisitionUnavailable({ reason: "unsupported" }))
                    : driver
                        .submit(context, {
                          session: command.input.session,
                          value: command.input.value,
                        })
                        .pipe(Effect.flatMap(statusOutput));
                case "cancel":
                  return driver.cancel(context, { session: command.input.session });
                case "remove":
                  // A failed save may release only this attempt, never a saved account by its ref.
                  return session.session === undefined
                    ? Effect.void
                    : driver.cancel(context, { session: session.session });
                case "check":
                  return Effect.fail(new AccountAcquisitionUnavailable({ reason: "unsupported" }));
              }
            },
          );
        });
    });
  return { select, prepare };
};
