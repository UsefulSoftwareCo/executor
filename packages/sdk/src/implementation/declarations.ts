import { Clock, Deferred, Effect, Exit, Fiber, Option, Result, Schema } from "effect";
import type { HostCrypto } from "./host-crypto.ts";
import { Digest } from "effect/crypto";
import { Hex } from "effect/encoding";
import {
  changeCheckMillis,
  declarationFreshness,
  declarationLimits,
  durableHeadStartMillis,
  type BackgroundWork,
  type DeclarationCache,
  type DeclarationLimits,
  type DurableDeclarations,
  type DurableEntry,
  type KeptEntry,
  type PendingLoad,
} from "../contracts/declarations.ts";
import type { HostApi, ResourceLifecycle } from "../contracts/executor.ts";
import type { AppRequirements } from "../contracts/apps.ts";
import { appCacheNamespace, type HostApiCheck } from "../contracts/host-api.ts";
import { type AccountId, type OwnerId, StorageError } from "../contracts/shared.ts";
import type { makeOAuth } from "./oauth.ts";
import { makeHandoff } from "./handoff.ts";
import { resolve, type InvocationSnapshot } from "./tools.ts";
import { accountAuthority } from "./selection.ts";

export const makeDeclarationCache = (
  limits: DeclarationLimits = declarationLimits,
): DeclarationCache => {
  const entries = new Map<string, KeptEntry>();
  const loads = new Map<string, PendingLoad>();
  const changes = new Map<string, number>();
  const checks = new Map<string, number>();
  let bytes = 0;
  let renewals = 0;
  const size = (entry: KeptEntry) => (entry.kind === "json" ? entry.json.length * 2 : entry.bytes);
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    bytes -= size(entry);
  };
  return {
    get: (key) =>
      Effect.sync(() => {
        const entry = entries.get(key);
        if (entry === undefined) return undefined;
        entries.delete(key);
        entries.set(key, entry);
        return entry;
      }),
    set: (key, entry) =>
      Effect.sync(() => {
        remove(key);
        if (entry.at <= (changes.get(entry.app) ?? -Infinity)) return;
        if (size(entry) > limits.entryBytes) return;
        entries.set(key, entry);
        bytes += size(entry);
        for (const oldest of entries.keys()) {
          if (entries.size <= limits.entries && bytes <= limits.bytes) break;
          remove(oldest);
        }
      }),
    pending: (key) => loads.get(key),
    begin: (key, load) => {
      loads.set(key, load);
    },
    end: (key, load) => {
      if (loads.get(key) === load) loads.delete(key);
    },
    changed: (app, at) => {
      if (at <= (changes.get(app) ?? -Infinity)) return;
      changes.set(app, at);
      for (const [key, entry] of entries) if (entry.app === app && entry.at <= at) remove(key);
    },
    outdated: (app, at) => at <= (changes.get(app) ?? -Infinity),
    checked: (app) => checks.get(app),
    check: (app, started) => {
      checks.set(app, started);
    },
    usage: () => ({ entries: entries.size, bytes }),
    renewing: () => {
      if (renewals >= limits.renewals) return false;
      renewals += 1;
      return true;
    },
    renewed: () => {
      renewals = Math.max(0, renewals - 1);
    },
  };
};

export const versionHostApi = (
  hostApi: HostApi | undefined,
  version: { readonly requirements: AppRequirements },
): HostApiCheck | undefined =>
  hostApi !== undefined && hostApi.reads(version.requirements)
    ? { revision: hostApi.revision, documents: hostApi.documents }
    : undefined;

const JsonText = Schema.fromJsonString(Schema.Unknown);

export const makeDeclarations = (options: {
  readonly cache: DeclarationCache;
  readonly durable: DurableDeclarations | undefined;
  readonly background: BackgroundWork | undefined;
  readonly resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"];
  readonly accountsUsable: ReturnType<typeof makeOAuth>["usableAll"];
  readonly accountsUsableEach: ReturnType<typeof makeOAuth>["usableEach"];
  readonly crypto: HostCrypto;
  readonly lifecycle: ResourceLifecycle | undefined;
  readonly hostApi: HostApi | undefined;
}) => {
  const digest = (bytes: Uint8Array) =>
    options.crypto.digest.digest(Digest.sha256, bytes).pipe(Effect.map(Hex.encode));
  const key = (command: string, state: InvocationSnapshot) =>
    Effect.gen(function* () {
      const selections = state.selections.map(({ slot, accounts }) => [
        slot,
        accounts.map((account) => [
          account.id,
          account.provider,
          account.method,
          account.credentialGeneration,
        ]),
      ]);
      return yield* digest(
        new TextEncoder().encode(
          JSON.stringify([
            command,
            state.app.owner,
            state.app.id,
            state.version.id,
            appCacheNamespace(state.version.build, versionHostApi(options.hostApi, state.version)),
            state.scope,
            selections,
          ]),
        ),
      );
    });
  const checksOf = (state: InvocationSnapshot) => {
    const selected = state.selections.flatMap(({ required, accounts }) =>
      accounts.map((account) => ({ account, provider: required.definition })),
    );
    const { user: linked, app: appUses } = accountAuthority(state.selections);
    return {
      selected,
      linked,
      appUses,
      permitted: (allowed: ReadonlySet<AccountId>) =>
        selected.every(({ account }) => allowed.has(account.id)),
    };
  };
  const authorize = (state: InvocationSnapshot) =>
    Effect.gen(function* () {
      const lifecycle = options.lifecycle;
      const checks = checksOf(state);
      yield* Effect.all(
        [
          lifecycle === undefined
            ? Effect.void
            : lifecycle
                .appResolving(state.app, checks.linked, checks.appUses)
                .pipe(
                  Effect.flatMap((allowed) =>
                    checks.permitted(allowed) ? Effect.void : Effect.fail(new StorageError()),
                  ),
                ),
          options.accountsUsable(checks.selected),
        ],
        { concurrency: "unbounded", discard: true },
      );
    });
  const authorizeAll = (owner: OwnerId, states: ReadonlyArray<InvocationSnapshot>) =>
    Effect.gen(function* () {
      const lifecycle = options.lifecycle;
      const checks = states.map(checksOf);
      const [rechecked, usable] = yield* Effect.all(
        [
          lifecycle === undefined || states.length === 0
            ? Effect.succeed(undefined)
            : lifecycle.appsResolving(
                owner,
                states.map((state, index) => ({
                  id: state.app.id,
                  accounts: checks[index]?.linked ?? [],
                  appUses: checks[index]?.appUses ?? [],
                })),
              ),
          options.accountsUsableEach(checks.map(({ selected }) => selected)),
        ],
        { concurrency: "unbounded" },
      );
      return checks.map(
        (check, index): Result.Result<void, Effect.Error<ReturnType<typeof authorize>>> => {
          const recheck = rechecked?.[index];
          if (recheck !== undefined) {
            if (Result.isFailure(recheck)) return Result.fail(recheck.failure);
            if (!check.permitted(recheck.success)) return Result.fail(new StorageError());
          }
          return usable[index] ?? Result.fail(new StorageError());
        },
      );
    });
  const recall = (app: string, id: string) =>
    options.durable === undefined ? Effect.succeed(undefined) : options.durable.get(app, id);
  const persist = <E>(
    app: string,
    id: string,
    entry: Effect.Effect<DurableEntry & { readonly until: number }, E>,
  ): Effect.Effect<void> => {
    const durable = options.durable;
    if (durable === undefined) return Effect.void;
    return entry.pipe(
      Effect.flatMap((kept) => durable.set(app, id, kept)),
      Effect.catchCause(() => Effect.logWarning("Durable declaration write failed")),
    );
  };
  const persistAfterReply = <E>(
    app: string,
    id: string,
    entry: Effect.Effect<DurableEntry & { readonly until: number }, E>,
  ): Effect.Effect<void> => {
    const write = persist(app, id, entry);
    return options.durable === undefined || options.background === undefined
      ? write
      : options.background(write).pipe(Effect.asVoid);
  };
  const followChanges = (app: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const durable = options.durable;
      if (durable === undefined) return;
      const now = yield* Clock.currentTimeMillis;
      const last = options.cache.checked(app);
      if (last !== undefined && now - last < changeCheckMillis) return;
      options.cache.check(app, now);
      const read = durable.changed(app).pipe(
        Effect.tap((at) =>
          Effect.sync(() => {
            if (at !== undefined) options.cache.changed(app, at);
          }),
        ),
        Effect.asVoid,
      );
      const accepted = options.background === undefined ? false : yield* options.background(read);
      if (!accepted) yield* read;
    });
  return {
    key,
    followChanges,
    hostApi: (version: Parameters<typeof versionHostApi>[1]) =>
      versionHostApi(options.hostApi, version),
    authorize,
    authorizeAll,
    recall,
    persist,
    read: <E>(
      command: string,
      state: InvocationSnapshot,
      evaluate: (context: Effect.Success<ReturnType<typeof resolve>>) => Effect.Effect<unknown, E>,
      policy: {
        readonly retain?: (value: unknown) => boolean;
        readonly current?: (value: unknown) => Effect.Effect<boolean>;
        readonly revalidate?: (value: unknown) => boolean;
        readonly live?: boolean;
        readonly refreshStale?: boolean;
      } = {},
    ) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const evaluated = resolve(state, options.resolveAccount).pipe(Effect.flatMap(evaluate));
        if (policy.live === true) {
          yield* Effect.annotateCurrentSpan("executor.declarations.cache", "live");
          return yield* evaluated;
        }
        const id = yield* key(command, state);
        const evaluation = Effect.gen(function* () {
          const value = yield* evaluated;
          if (policy.retain !== undefined && !policy.retain(value))
            return { value, kept: undefined };
          const json = yield* Schema.encodeEffect(JsonText)(value).pipe(
            Effect.mapError(() => new StorageError()),
          );
          yield* options.cache.set(id, { kind: "json", app: state.app.id, at: started, json });
          const kept = { at: started, json, until: started + declarationFreshness.maxStaleMillis };
          return { value, kept };
        });
        const load = evaluation.pipe(
          Effect.tap(({ kept }) =>
            kept === undefined
              ? Effect.void
              : persistAfterReply(state.app.id, id, Effect.succeed(kept)),
          ),
          Effect.map(({ value }) => value),
        );
        const refreshed = evaluation.pipe(
          Effect.flatMap(({ kept }) =>
            kept === undefined ? Effect.void : persist(state.app.id, id, Effect.succeed(kept)),
          ),
        );
        const fresh = (entry: KeptEntry | undefined, now: number) =>
          entry?.kind === "json" && now - entry.at < declarationFreshness.maxStaleMillis
            ? entry
            : undefined;
        const miss = Effect.annotateCurrentSpan("executor.declarations.cache", "miss").pipe(
          Effect.andThen(load),
        );
        const serve = (cached: KeptEntry & { readonly kind: "json" }) =>
          Effect.gen(function* () {
            const age = (yield* Clock.currentTimeMillis) - cached.at;
            if (age >= declarationFreshness.maxStaleMillis) return yield* miss;
            const decoded = yield* Schema.decodeEffect(JsonText)(cached.json).pipe(Effect.option);
            if (Option.isNone(decoded)) {
              yield* Effect.annotateCurrentSpan("executor.declarations.cache", "miss");
              return yield* load;
            }
            const value = decoded.value;
            if (policy.current !== undefined && !(yield* policy.current(value))) {
              yield* Effect.annotateCurrentSpan("executor.declarations.cache", "outdated");
              return yield* load;
            }
            const stale = age >= declarationFreshness.freshMillis;
            const background = options.background;
            if (stale && policy.refreshStale === false) {
              yield* authorize(state);
              yield* Effect.annotateCurrentSpan({
                "executor.declarations.cache": "stale",
                "executor.declarations.age_ms": age,
              });
              return value;
            }
            if (stale && background === undefined) {
              yield* Effect.annotateCurrentSpan("executor.declarations.cache", "expired");
              return yield* load;
            }
            if (stale && policy.revalidate?.(value) === true) {
              yield* Effect.annotateCurrentSpan({
                "executor.declarations.cache": "revalidated",
                "executor.declarations.age_ms": age,
              });
              return yield* load;
            }
            yield* authorize(state);
            yield* Effect.annotateCurrentSpan({
              "executor.declarations.cache": stale ? "stale" : "hit",
              "executor.declarations.age_ms": age,
            });
            if (stale && background !== undefined)
              yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  if (options.cache.pending(id) !== undefined) return;
                  const refresh: PendingLoad = {
                    started: yield* Clock.currentTimeMillis,
                    waiters: 0,
                    overdue: false,
                    unwatched: makeHandoff(),
                    done: makeHandoff(),
                  };
                  options.cache.begin(id, refresh);
                  const accepted = yield* background(
                    refreshed.pipe(
                      Effect.timeout(declarationFreshness.refreshMillis),
                      Effect.catchCause(() => Effect.logWarning("Declaration refresh failed")),
                      Effect.asVoid,
                      Effect.onExit(() =>
                        Effect.suspend(() => {
                          options.cache.end(id, refresh);
                          return refresh.done.settle(undefined);
                        }),
                      ),
                      Effect.withSpan("sdk.declarations.refresh"),
                    ),
                  );
                  if (!accepted) options.cache.end(id, refresh);
                }),
              );
            return value;
          });
        const beside = Effect.uninterruptible(
          Effect.gen(function* () {
            const background = options.background;
            if (background === undefined || options.cache.pending(id) !== undefined) return miss;
            const result = yield* Deferred.make<
              Effect.Success<typeof evaluation>,
              Effect.Error<typeof evaluation>
            >();
            const load: PendingLoad = {
              started: yield* Clock.currentTimeMillis,
              waiters: 0,
              overdue: false,
              unwatched: makeHandoff(),
              done: makeHandoff(),
            };
            options.cache.begin(id, load);
            const accepted = yield* background(
              evaluation.pipe(
                Effect.exit,
                Effect.tap((exit) => Deferred.done(result, exit)),
                Effect.flatMap((exit) =>
                  Exit.isSuccess(exit) && exit.value.kept !== undefined
                    ? persist(state.app.id, id, Effect.succeed(exit.value.kept))
                    : Effect.void,
                ),
                Effect.raceFirst(
                  Effect.sleep(declarationFreshness.refreshMillis).pipe(
                    Effect.andThen(load.unwatched.await),
                    Effect.andThen(Effect.logWarning("Declaration evaluation stopped")),
                  ),
                ),
                Effect.onExit(() =>
                  Effect.suspend(() => {
                    options.cache.end(id, load);
                    return load.done.settle(undefined);
                  }),
                ),
                Effect.ensuring(Deferred.interrupt(result)),
                Effect.asVoid,
                Effect.withSpan("sdk.declarations.evaluate"),
                Effect.interruptible,
              ),
            );
            if (!accepted) {
              options.cache.end(id, load);
              return miss;
            }
            return Effect.annotateCurrentSpan("executor.declarations.cache", "miss").pipe(
              Effect.andThen(Deferred.await(result)),
              Effect.ensuring(load.unwatched.settle(undefined)),
              Effect.map(({ value }) => value),
            );
          }),
        );
        yield* followChanges(state.app.id);
        const kept = fresh(yield* options.cache.get(id), yield* Clock.currentTimeMillis);
        if (kept?.kind === "json") return yield* serve(kept);
        if (options.durable === undefined) return yield* miss;
        const recalling = yield* Effect.forkChild(
          recall(state.app.id, id).pipe(
            Effect.flatMap((found) =>
              Effect.gen(function* () {
                if (found === undefined || options.cache.outdated(state.app.id, found.at))
                  return undefined;
                const entry = { kind: "json" as const, app: state.app.id, ...found };
                yield* options.cache.set(id, entry);
                return fresh(entry, yield* Clock.currentTimeMillis);
              }),
            ),
          ),
        );
        const recalled = (found: KeptEntry | undefined) =>
          found?.kind === "json"
            ? Effect.annotateCurrentSpan("executor.declarations.source", "durable").pipe(
                Effect.andThen(serve(found)),
              )
            : undefined;
        const early = yield* Fiber.join(recalling).pipe(
          policy.refreshStale === false
            ? Effect.map(Option.some)
            : Effect.timeoutOption(durableHeadStartMillis),
        );
        if (Option.isSome(early)) return yield* recalled(early.value) ?? miss;
        return yield* Effect.raceFirst(
          yield* beside,
          Fiber.join(recalling).pipe(Effect.flatMap((found) => recalled(found) ?? Effect.never)),
        );
      }).pipe(
        Effect.withSpan("sdk.declarations.read", {
          attributes: { "executor.declarations.command": command },
        }),
      ),
  };
};
export type Declarations = ReturnType<typeof makeDeclarations>;
