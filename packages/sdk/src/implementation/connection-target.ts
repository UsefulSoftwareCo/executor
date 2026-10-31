/** Capture and apply one app requirement, independently of account authentication. */
import { Effect } from "effect";
import {
  AccountConnectionTargetChanged,
  type CreateAccountConnection,
} from "../contracts/account-connection.ts";
import { AccountProvisioned, connectableMethods } from "../contracts/provider.ts";
import { AccountSelectionInvalid } from "../contracts/apps.ts";
import type { Account } from "../contracts/account.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import { StorageError, type AccountConnectionId, type ProviderId } from "../contracts/shared.ts";
import type { StoredConnectionTarget } from "../contracts/storage.ts";
import { lockApp, storedApp, storedVersion } from "./apps.ts";
import { query, type Query } from "./database.ts";

/**
 * Resolve a provider from the deployed requirement without evaluating account-dependent app code.
 * The requirement's scope is kept with the target. A caller that started the connection for a
 * scope finds the requirement moved if it has another one now.
 */
export const captureConnectionTarget = (
  db: Query,
  target: typeof CreateAccountConnection.Type.target,
) =>
  Effect.gen(function* () {
    const app = yield* storedApp(db, target);
    const version = yield* storedVersion(db, app).pipe(Effect.mapError(() => new StorageError()));
    const requirement = Object.hasOwn(version.requirements.accounts, target.requirement)
      ? version.requirements.accounts[target.requirement]
      : undefined;
    const invalid = (reason: AccountSelectionInvalid["reason"]) =>
      new AccountSelectionInvalid({ app: app.id, slot: target.requirement, reason });
    if (requirement === undefined) return yield* invalid("unknown_slot");
    if (connectableMethods(requirement.definition).length === 0)
      return yield* new AccountProvisioned({ provider: requirement.provider });
    if (target.scope !== undefined && target.scope !== requirement.scope)
      return yield* new AccountConnectionTargetChanged({
        app: app.id,
        requirement: target.requirement,
      });
    const snapshot: StoredConnectionTarget = {
      app: target.app,
      requirement: target.requirement,
      scope: requirement.scope,
      name: app.name,
      owner: app.owner,
    };
    return { provider: requirement.provider, snapshot };
  });

/**
 * The provider as the target app declares it now, with the hosts connecting will grant. Undefined
 * when the app no longer requires this provider for the slot, or requires it in another scope; the
 * request can then never complete.
 */
export const targetProvider = (db: Query, target: StoredConnectionTarget, provider: ProviderId) =>
  Effect.gen(function* () {
    const app = yield* storedApp(db, { app: target.app, owner: target.owner }).pipe(
      Effect.catchTag("AppNotFound", () => Effect.succeed(undefined)),
    );
    if (app === undefined) return undefined;
    const version = yield* storedVersion(db, app).pipe(
      Effect.catchTags({
        VersionNotFound: () => Effect.succeed(undefined),
        AppNotDeployed: () => Effect.succeed(undefined),
      }),
    );
    const required =
      version !== undefined && Object.hasOwn(version.requirements.accounts, target.requirement)
        ? version.requirements.accounts[target.requirement]
        : undefined;
    return required?.provider === provider && required.scope === target.scope
      ? { id: provider, definition: required.definition }
      : undefined;
  });

/**
 * A request whose app no longer requires its provider for the slot can never complete. Report that
 * before showing the old provider's sign-in, validating its fields or contacting its service.
 */
export const requireTargetProvider = (
  db: Query,
  row: { readonly target: StoredConnectionTarget; readonly provider: ProviderId },
) =>
  Effect.gen(function* () {
    const shown = yield* targetProvider(db, row.target, row.provider);
    if (shown === undefined)
      return yield* new AccountConnectionTargetChanged({
        app: row.target.app,
        requirement: row.target.requirement,
      });
    return shown;
  });

/**
 * Run in the account-save transaction, under the app's lock. The product links the account to the
 * requirement in the scope the connection started for, in the same transaction. A changed target,
 * including a requirement that moved to the other scope since, rolls back the credentials and the
 * link together.
 */
export const applyConnectionTarget = (
  db: Query,
  connection: AccountConnectionId,
  target: StoredConnectionTarget,
  provider: ProviderId,
  account: Account,
  lifecycle: ResourceLifecycle | undefined,
) =>
  Effect.gen(function* () {
    const changed = () =>
      new AccountConnectionTargetChanged({ app: target.app, requirement: target.requirement });
    const app = yield* lockApp(db, { app: target.app, owner: target.owner }).pipe(
      Effect.catchTag("AppNotFound", () => Effect.fail(changed())),
    );
    const version = yield* storedVersion(db, app).pipe(
      Effect.catchTags({
        VersionNotFound: () => Effect.fail(changed()),
        AppNotDeployed: () => Effect.fail(changed()),
      }),
    );
    const required = Object.hasOwn(version.requirements.accounts, target.requirement)
      ? version.requirements.accounts[target.requirement]
      : undefined;
    if (
      required === undefined ||
      required.provider !== provider ||
      required.provider !== account.provider ||
      required.scope !== target.scope
    )
      return yield* changed();
    // Connecting for this app grants the hosts it declares, replacing any earlier grant.
    yield* query(() =>
      db.updateMany("accounts", {
        where: (b) => b("id", "=", account.id),
        set: { allowedHosts: required.definition.hosts ?? null },
      }),
    );
    if (lifecycle !== undefined)
      yield* lifecycle.appAccountConnected({
        connection,
        app: app.id,
        requirement: target.requirement,
        scope: target.scope,
        account,
      });
  });
