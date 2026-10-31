import { AccountProvisioned } from "../contracts/provider.ts";
/** Persisted interactive acquisition. Short claims serialize calls without holding SQL over HTTP. */
import { Clock, type Crypto, Effect, Schema } from "effect";
import { InteractiveStart, InteractiveStatus, type ConnectCommand } from "apps/contracts";
import {
  InteractiveConnectionFailed,
  type InteractiveHost,
  type InteractiveSession,
  type InteractiveBinding,
} from "../contracts/interactive-accounts.ts";
import { CurrentActor } from "../contracts/executor.ts";
import { backgroundAccounts } from "./background-accounts.ts";
import { makeInteractiveAttempts, interactiveCancelMillis } from "./interactive-attempts.ts";
import { StorageError } from "../contracts/shared.ts";
import type { Credentials } from "../contracts/storage.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import type { Runtime } from "../contracts/runtime.ts";
import type { makeOAuth } from "./oauth.ts";
import { query, transaction, type Query } from "./database.ts";
import {
  lockConnection,
  readConnection,
  finishConnection,
  savingConnection,
  type ConnectionRow,
} from "./connection-state.ts";
import { storedApp } from "./apps.ts";
import {
  interactiveBinding,
  pendingInteractive,
  writeInteractive,
  interactiveClaims,
  type InteractiveInput as Input,
  type InteractiveClaim as Claim,
} from "./interactive-state.ts";
import {
  prepareInteractiveCall,
  prepareInteractiveContext,
  interactiveStepMillis,
  saveInteractiveAccount,
} from "./interactive-runner.ts";
import type { makeAcquisitionConnect } from "./account-acquisition-connect.ts";
import { AccountAcquisitionUnavailable } from "../contracts/account-acquisition-driver.ts";

import {
  InteractiveRetirementBusy,
  InteractiveRetirementFailed,
} from "../contracts/interactive-errors.ts";
const failure = () => new InteractiveConnectionFailed({ reason: "step" });
const safe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      Schema.is(StorageError)(error) ||
      Schema.is(AccountProvisioned)(error) ||
      Schema.is(InteractiveRetirementBusy)(error) ||
      Schema.is(InteractiveRetirementFailed)(error) ||
      Schema.is(AccountAcquisitionUnavailable)(error)
        ? error
        : failure(),
    ),
  );

export const makeInteractiveAccounts = (
  db: Query,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  runtime: Runtime,
  resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"],
  lifecycle?: ResourceLifecycle,
  hostApi?: import("../contracts/executor.ts").HostApi,
  acquisitionDriver?: ReturnType<typeof makeAcquisitionConnect>,
): Omit<InteractiveHost, "retire" | "acquired"> & {
  readonly prepareRemoval: (
    input: Parameters<InteractiveHost["remove"]>[0],
  ) => Effect.Effect<
    ReturnType<InteractiveHost["remove"]>,
    import("../contracts/interactive-accounts.ts").InteractiveConnectionFailed | StorageError
  >;
  readonly clearAttempt: ReturnType<typeof makeInteractiveAttempts>["clearAttempt"];
} => {
  const { cancelAttempt, clearAttempt } = makeInteractiveAttempts(
    db,
    crypto,
    runtime,
    resolveAccount,
    lifecycle,
    hostApi,
    acquisitionDriver,
  );
  const prepareCall = prepareInteractiveCall(db, runtime, resolveAccount, hostApi);
  const prepareLegacyContext = prepareInteractiveContext(db, runtime, resolveAccount, hostApi);
  const acquisition = (row: ConnectionRow, session: InteractiveSession) => ({
    app: row.target.app,
    slot: row.target.requirement,
    version: session.version,
  });
  const prepareContext = (
    input: Input,
    row: ConnectionRow,
    session: InteractiveSession,
    command: ConnectCommand,
  ) =>
    Effect.gen(function* () {
      const driver =
        acquisitionDriver === undefined
          ? undefined
          : yield* acquisitionDriver.prepare(row, session);
      return (
        driver ??
        (yield* prepareLegacyContext({
          owner: input.owner,
          accounts: input.accounts,
          acquisition: acquisition(row, session),
          command,
        }))
      );
    });
  const run = (
    input: Input,
    row: ConnectionRow,
    session: InteractiveSession,
    command: ConnectCommand,
  ) => Effect.flatMap(prepareContext(input, row, session, command), (invoke) => invoke(command));
  const { claim, current, recordFailure, settled } = interactiveClaims(
    db,
    crypto,
    interactiveStepMillis,
    interactiveStepMillis + interactiveCancelMillis,
    acquisitionDriver?.select,
  );
  const cleanup = (input: Input, claimed: Claim, command: ConnectCommand) =>
    run(input, claimed.row, claimed.session, command).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.logWarning("Interactive sign-in cleanup did not finish")),
    );

  const progress = (input: Input, step: "status" | "submit", value?: string) =>
    Effect.gen(function* () {
      const existing = yield* readConnection(db, input);
      if (existing.state.status === "completed")
        return { state: "connected" as const, account: existing.state.account };
      const previous = pendingInteractive(existing);
      if (previous?.failed !== undefined)
        return { state: "failed" as const, message: previous.failed };
      if (
        previous?.instructions?.expiresAt !== undefined &&
        previous.instructions.expiresAt <= (yield* Clock.currentTimeMillis)
      )
        return {
          state: "failed" as const,
          message: "This sign-in has expired. Cancel and start again.",
        };
      const claimed = yield* claim(input);
      if (claimed === undefined) return { state: "waiting" as const };
      const session = claimed.session.session;
      if (session === undefined) return yield* failure();
      const command: ConnectCommand =
        step === "submit"
          ? {
              operation: "connect",
              slot: claimed.row.target.requirement,
              step,
              input: { method: claimed.session.method, session, value: value ?? "" },
            }
          : {
              operation: "connect",
              slot: claimed.row.target.requirement,
              step,
              input: { method: claimed.session.method, session },
            };
      // Retain the actual invocation context before the handler can race with app deletion.
      const invoke = yield* prepareContext(input, claimed.row, claimed.session, command);
      const result = yield* invoke(command).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(InteractiveStatus)),
        Effect.onError(() => recordFailure(input, claimed)),
      );
      const persist = transaction(db, (tx) =>
        Effect.gen(function* () {
          const row = yield* current(tx, input, claimed);
          if (result.state !== "connected") {
            yield* writeInteractive(tx, row, {
              ...settled(claimed.session),
              ...(result.state === "failed" ? { failed: result.message } : {}),
            });
            return result;
          }
          const binding: InteractiveBinding = {
            ...acquisition(row, claimed.session),
            method: claimed.session.method,
            ref: result.ref,
            acquiredAt: yield* Clock.currentTimeMillis,
            ...(result.accountInfo === undefined ? {} : { accountInfo: result.accountInfo }),
          };
          const account = yield* saveInteractiveAccount(
            tx,
            credentials,
            crypto,
            row,
            binding,
            result,
            lifecycle,
            claimed.session.driver,
          );
          yield* finishConnection(
            tx,
            row,
            account,
            lifecycle,
            claimed.session.driver === undefined ? binding : undefined,
          );
          return { state: "connected" as const, account };
        }),
      );
      return yield* (
        result.state === "connected"
          ? savingConnection(lifecycle, input.connection, persist)
          : persist
      ).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            yield* recordFailure(input, claimed).pipe(
              Effect.catch(() =>
                Effect.logWarning("The completed sign-in could not record its failure"),
              ),
            );
            if (result.state === "connected")
              yield* invoke({
                operation: "connect",
                slot: claimed.row.target.requirement,
                step: "remove",
                input: { method: claimed.session.method, ref: result.ref },
              }).pipe(
                Effect.asVoid,
                Effect.catch(() =>
                  Effect.logWarning(
                    "Completed interactive sign-in cleanup did not finish; dropping the reference",
                  ),
                ),
              );
          }),
        ),
      );
    });

  const prepareRemoval = (input: Parameters<InteractiveHost["remove"]>[0]) =>
    safe(
      Effect.gen(function* () {
        const binding = yield* interactiveBinding(db, input);
        if (binding === undefined) return Effect.void;
        if (
          (yield* query(() =>
            db.findFirst("webhookAccounts", { where: (b) => b("account", "=", input.account) }),
          )) !== null ||
          (yield* query(() =>
            db.findFirst("workflowAccounts", { where: (b) => b("account", "=", input.account) }),
          )) !== null
        )
          return yield* failure();
        const app = yield* storedApp(db, { app: binding.app, owner: input.owner }).pipe(
          Effect.catchTag("AppNotFound", () => Effect.succeed(undefined)),
        );
        if (app === undefined) {
          yield* Effect.logWarning(
            "The acquiring app is gone; deleting its interactive account without remove",
          );
          return Effect.void;
        }
        const accounts =
          input.accounts ??
          (yield* backgroundAccounts(db, lifecycle, {
            app: binding.app,
            version: binding.version,
            actor: yield* CurrentActor,
            connecting: binding.slot,
          }));
        const call = yield* prepareCall({
          owner: input.owner,
          accounts,
          acquisition: binding,
          command: {
            operation: "connect",
            slot: binding.slot,
            step: "remove",
            input: { method: binding.method, ref: binding.ref },
          },
        });
        return Effect.asVoid(call);
      }),
    );

  return {
    binding: (input) => interactiveBinding(db, input),
    start: (input) =>
      safe(
        Effect.gen(function* () {
          const existing = yield* readConnection(db, input);
          const previous = pendingInteractive(existing);
          if (
            existing.state.status === "pending" &&
            previous?.method === input.method &&
            previous.instructions !== undefined &&
            previous.failed === undefined &&
            (previous.running === undefined ||
              (previous.leaseExpiresAt ?? 0) > (yield* Clock.currentTimeMillis)) &&
            (previous.instructions.expiresAt === undefined ||
              previous.instructions.expiresAt > (yield* Clock.currentTimeMillis))
          )
            return previous.instructions;
          const claimed = yield* claim(input, input.method);
          if (claimed === undefined) return yield* failure();
          yield* cancelAttempt(claimed.row, input.accounts);
          const started = yield* run(input, claimed.row, claimed.session, {
            operation: "connect",
            slot: claimed.row.target.requirement,
            step: "start",
            input: { method: input.method },
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(InteractiveStart)),
            Effect.onError(() => recordFailure(input, claimed)),
          );
          const { session, ...instructions } = started;
          yield* transaction(db, (tx) =>
            Effect.gen(function* () {
              const row = yield* current(tx, input, claimed);
              yield* writeInteractive(tx, row, {
                ...settled(claimed.session),
                session,
                instructions,
              });
            }),
          ).pipe(
            Effect.onError(() =>
              cleanup(input, claimed, {
                operation: "connect",
                slot: claimed.row.target.requirement,
                step: "cancel",
                input: { method: input.method, session },
              }),
            ),
          );
          return instructions;
        }),
      ),
    status: (input) => safe(progress(input, "status")),
    submit: (input) => safe(progress(input, "submit", input.value)),
    cancel: (input) =>
      safe(
        Effect.gen(function* () {
          const row = yield* transaction(db, (tx) =>
            Effect.gen(function* () {
              const row = yield* lockConnection(tx, input, crypto);
              if (row.state.status === "completed" || row.state.status === "cancelled")
                return undefined;
              yield* query(() =>
                tx.updateMany("accountConnections", {
                  where: (b) => b("id", "=", row.id),
                  set: { state: { status: "cancelled" }, oauthAttempt: null },
                }),
              );
              return row;
            }),
          );
          if (row === undefined) return;
          const session = pendingInteractive(row);
          if (session?.session !== undefined)
            yield* run(input, row, session, {
              operation: "connect",
              slot: row.target.requirement,
              step: "cancel",
              input: { method: session.method, session: session.session },
            }).pipe(
              Effect.catch(() => Effect.logWarning("Cancelled interactive attempt cleanup failed")),
            );
        }),
      ),
    prepareRemoval,
    clearAttempt,
    remove: (input) => safe(Effect.flatten(prepareRemoval(input))),
  };
};
