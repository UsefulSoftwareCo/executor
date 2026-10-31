import { privateAccountCheck } from "./account-status-output.ts";
/** Check an app-owned reference with the caller's current linked accounts and normal app authority. */
import { Effect, Redacted, Schema } from "effect";
import { AccountCheckResult } from "apps/contracts";
import { CurrentActor, type HostApi, type ResourceLifecycle } from "../contracts/executor.ts";
import type { Runtime } from "../contracts/runtime.ts";
import { StorageError, type AppId } from "../contracts/shared.ts";
import type { StoredVersion } from "../contracts/storage.ts";
import type { InteractiveBinding } from "../contracts/interactive-accounts.ts";
import { backgroundAccounts } from "./background-accounts.ts";
import { snapshot, resolve } from "./tools.ts";
import type { makeOAuth } from "./oauth.ts";
import type { Query } from "./database.ts";

export const checkInteractiveAccount = (
  db: Query,
  runtime: Runtime,
  resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"],
  lifecycle: ResourceLifecycle | undefined,
  input: {
    readonly app: AppId;
    readonly version: StoredVersion;
    readonly hostApi: HostApi | undefined;
    readonly acquired: InteractiveBinding;
    readonly method: string;
    readonly deadline: number;
  },
) =>
  Effect.gen(function* () {
    const { app, version, hostApi, acquired, method, deadline } = input;
    if (acquired.app !== app) return yield* new StorageError();
    const accounts = yield* backgroundAccounts(db, lifecycle, {
      app,
      version: version.id,
      actor: yield* CurrentActor,
      connecting: acquired.slot,
    });
    const state = yield* snapshot(db, {
      app,
      version: version.id,
      accounts,
      connecting: acquired.slot,
    });
    const context = yield* resolve(state, resolveAccount);
    const result = yield* runtime.connect({
      ...context,
      app,
      build: version.build,
      hostApi,
      database: version.requirements.sql === true,
      deadline,
      command: {
        operation: "connect",
        slot: acquired.slot,
        step: "check",
        input: { method, ref: acquired.ref },
      },
    });
    if (result === null) return undefined;
    const checked = yield* Schema.decodeUnknownEffect(AccountCheckResult)(result);
    return yield* privateAccountCheck(checked, Redacted.value(context.accounts), acquired.ref);
  });
