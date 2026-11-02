/** Run acquisition handlers through the ordinary app host, with current linked credentials. */
import { Clock, type Crypto, Effect, Redacted, Schema } from "effect";
import type { AccountInfo, ConnectCommand, InteractiveStatus } from "apps/contracts";
import { AccountId, StorageError, type OwnerId } from "../contracts/shared.ts";
import {
  InteractiveConnectionFailed,
  type InteractiveBinding,
} from "../contracts/interactive-accounts.ts";
import type { AppAccounts } from "../contracts/apps.ts";
import type { Credentials } from "../contracts/storage.ts";
import type { Runtime } from "../contracts/runtime.ts";
import type { HostApi, ResourceLifecycle } from "../contracts/executor.ts";
import type { makeOAuth } from "./oauth.ts";
import { defaultLabel, ownedAccount, publicAccount } from "./accounts.ts";
import { versionHostApi } from "./declarations.ts";
import { snapshot, resolve, resolveRemoval } from "./tools.ts";
import { query, type Query } from "./database.ts";
import type { ConnectionRow } from "./connection-state.ts";
import { interactiveBinding } from "./interactive-state.ts";

/** The limit includes credential resolution, app startup and the handler itself. */
export const interactiveStepMillis = 15_000;

/** Resolve the retained handler and credentials before a local mutation can remove their rows. */
export const prepareInteractiveContext =
  (
    db: Query,
    runtime: Runtime,
    resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"],
    hostApi?: HostApi,
  ) =>
  (input: {
    readonly owner: OwnerId;
    readonly acquisition: Pick<InteractiveBinding, "app" | "slot" | "version">;
    readonly accounts: AppAccounts;
    readonly command: ConnectCommand;
  }) =>
    Effect.gen(function* () {
      const state = yield* snapshot(db, {
        app: input.acquisition.app,
        version: input.acquisition.version,
        accounts:
          input.command.step !== "remove"
            ? input.accounts
            : {
                app: Object.fromEntries(
                  Object.entries(input.accounts.app).filter(
                    ([slot]) => slot !== input.acquisition.slot,
                  ),
                ),
                ...(input.accounts.user === undefined
                  ? {}
                  : {
                      user: Object.fromEntries(
                        Object.entries(input.accounts.user).filter(
                          ([slot]) => slot !== input.acquisition.slot,
                        ),
                      ),
                    }),
              },
        connecting: input.acquisition.slot,
      });
      if (state.app.owner !== input.owner) return yield* new StorageError();
      const context = yield* input.command.step === "remove"
        ? resolveRemoval(state, resolveAccount)
        : resolve(state, resolveAccount);
      return (command: ConnectCommand) =>
        Effect.gen(function* () {
          const bound = Redacted.value(context.accounts);
          const omitSlot = <A>(slots: Readonly<Record<string, A>>) =>
            Object.fromEntries(
              Object.entries(slots).filter(([slot]) => slot !== input.acquisition.slot),
            );
          const accounts =
            command.step === "remove"
              ? Redacted.make({
                  app: omitSlot(bound.app),
                  ...(bound.user === undefined ? {} : { user: omitSlot(bound.user) }),
                })
              : context.accounts;
          const deadline = (yield* Clock.currentTimeMillis) + interactiveStepMillis;
          return yield* runtime.connect({
            ...context,
            accounts,
            app: state.app.id,
            build: state.version.build,
            hostApi: versionHostApi(hostApi, state.version),
            database: state.version.requirements.sql === true,
            deadline,
            command,
          });
        }).pipe(
          Effect.timeout(interactiveStepMillis),
          Effect.mapError(() => new InteractiveConnectionFailed({ reason: "step" })),
        );
    }).pipe(
      Effect.timeout(interactiveStepMillis),
      Effect.mapError((error) =>
        Schema.is(StorageError)(error)
          ? error
          : new InteractiveConnectionFailed({ reason: "step" }),
      ),
      Effect.withSpan("sdk.connections.interactive.invoke"),
    );

/** A single command, or a retained context used to compensate an in-flight sign-in. */
export const prepareInteractiveCall = (
  ...services: Parameters<typeof prepareInteractiveContext>
) => {
  const prepare = prepareInteractiveContext(...services);
  return (input: Parameters<typeof prepare>[0]) =>
    prepare(input).pipe(Effect.map((invoke) => invoke(input.command)));
};

export const interactiveRunner = (...services: Parameters<typeof prepareInteractiveCall>) => {
  const prepare = prepareInteractiveCall(...services);
  return (input: Parameters<typeof prepare>[0]) =>
    Effect.flatten(prepare(input)).pipe(Effect.timeout(interactiveStepMillis));
};

/** Save the opaque reference with the same name and product lifecycle used by other connects. */
/** The most specific name in reported identity, bounded like a label the person types. */
const identityLabel = (info: AccountInfo | undefined) => {
  const name = (info?.displayName ?? info?.username ?? info?.email)?.trim();
  return name ? name.slice(0, 120) : undefined;
};

export const saveInteractiveAccount = (
  db: Query,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  row: ConnectionRow,
  binding: InteractiveBinding,
  connected: Extract<InteractiveStatus, { readonly state: "connected" }>,
  lifecycle: ResourceLifecycle | undefined,
) =>
  Effect.gen(function* () {
    const existing =
      row.reconnectAccount === null
        ? undefined
        : yield* ownedAccount(db, { account: row.reconnectAccount, owner: row.owner });
    if (existing !== undefined) {
      const previous = yield* interactiveBinding(db, { account: existing.id, owner: row.owner });
      if (previous?.app !== binding.app || existing.method !== binding.method)
        return yield* new InteractiveConnectionFailed({ reason: "step" });
    }
    const identity =
      existing === undefined
        ? {
            id: AccountId.make(
              `acc_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
            ),
            owner: row.owner,
            provider: row.provider,
            method: binding.method,
            // The identity the app reported names the account, as a connected Gmail shows its
            // address; without one it gets the owner's next free default name.
            label:
              identityLabel(connected.accountInfo) ??
              (yield* defaultLabel(db, row.owner, row.provider)),
            description: null,
            createdAt: new Date(yield* Clock.currentTimeMillis),
          }
        : yield* publicAccount(existing);
    const encryptedCredentials = yield* credentials
      .encrypt(identity.id, Redacted.make({ ref: connected.ref }))
      .pipe(Effect.mapError(() => new StorageError()));
    if (existing === undefined) {
      yield* query(() => db.create("accounts", { ...identity, encryptedCredentials }));
      if (lifecycle !== undefined) yield* lifecycle.accountCreated(identity);
    } else
      yield* query(() =>
        db.updateMany("accounts", {
          where: (b) => b("id", "=", identity.id),
          set: { encryptedCredentials, credentialGeneration: existing.credentialGeneration + 1 },
        }),
      );
    if (lifecycle !== undefined)
      yield* lifecycle.connectionCompleting({
        id: row.id,
        owner: row.owner,
        reconnectAccount: row.reconnectAccount,
        target: { app: row.target.app, requirement: row.target.requirement },
      });
    return identity;
  });
