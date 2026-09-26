/** Stale-while-revalidate reads of evaluated app declarations (skills, workflows, webhooks). */
import { Clock, Effect, Encoding, Option, Redacted, Schema, type Crypto } from "effect";
import {
  declarationFreshness,
  declarationLimits,
  type BackgroundWork,
  type DeclarationCache,
} from "../contracts/declarations.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import { CurrentProfile } from "../contracts/profiles.ts";
import { StorageError } from "../contracts/shared.ts";
import type { makeOAuth } from "./oauth.ts";
import { resolve, type InvocationSnapshot } from "./tools.ts";

/** One store per process or isolate. Least recently used entries leave first. */
export const makeDeclarationCache = (): DeclarationCache => {
  const entries = new Map<string, { readonly json: string; readonly at: number }>();
  const refreshing = new Map<string, number>();
  let bytes = 0;
  const size = (json: string) => json.length * 2;
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    bytes -= size(entry.json);
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
    set: (key, json, at) =>
      Effect.sync(() => {
        remove(key);
        if (size(json) > declarationLimits.entryBytes) return;
        entries.set(key, { json, at });
        bytes += size(json);
        for (const oldest of entries.keys()) {
          if (entries.size <= declarationLimits.entries && bytes <= declarationLimits.bytes) break;
          remove(oldest);
        }
      }),
    claim: (key, now) => {
      const started = refreshing.get(key);
      if (started !== undefined && now - started < declarationFreshness.maxStaleMillis)
        return false;
      refreshing.set(key, now);
      return true;
    },
    release: (key) => {
      refreshing.delete(key);
    },
  };
};

const JsonText = Schema.fromJsonString(Schema.Unknown);

/**
 * Evaluated declarations depend on the build, the profile revision, the selected accounts and
 * their stored credentials. Every read reruns the invocation snapshot; a kept result is served
 * only after the same lifecycle checks that precede credential release in an evaluation.
 */
export const makeDeclarations = (options: {
  readonly cache: DeclarationCache;
  readonly background: BackgroundWork | undefined;
  readonly resolveAccount: ReturnType<typeof makeOAuth>["resolve"];
  readonly accountUsable: ReturnType<typeof makeOAuth>["usable"];
  readonly crypto: Crypto.Crypto;
  readonly lifecycle: ResourceLifecycle | undefined;
}) => {
  const digest = (bytes: Uint8Array) =>
    options.crypto.digest("SHA-256", bytes).pipe(
      Effect.map(Encoding.encodeHex),
      Effect.mapError(() => new StorageError()),
    );
  const key = (command: string, state: InvocationSnapshot) =>
    Effect.gen(function* () {
      const selections = yield* Effect.forEach(state.selections, ({ slot, accounts }) =>
        Effect.forEach(accounts, (account) =>
          digest(Redacted.value(account.encryptedCredentials)).pipe(
            Effect.map((credentials) => [
              account.id,
              account.provider,
              account.method,
              credentials,
            ]),
          ),
        ).pipe(Effect.map((accounts) => [slot, accounts])),
      );
      return yield* digest(
        new TextEncoder().encode(
          JSON.stringify([
            command,
            state.app.owner,
            state.app.id,
            state.deployment.id,
            state.deployment.build,
            state.profile === undefined
              ? null
              : [state.profile.id, state.profile.revision, state.profile.subject],
            selections,
          ]),
        ),
      );
    });
  /**
   * The checks that precede credential release in a live evaluation, and the grant state that
   * would stop it: a kept result is never served for an account a live read would refuse, such
   * as an OAuth grant that needs reconnecting.
   */
  const authorize = (state: InvocationSnapshot) =>
    Effect.gen(function* () {
      const lifecycle = options.lifecycle;
      if (state.profile !== undefined && lifecycle?.profileResolving)
        yield* lifecycle.profileResolving(state.profile);
      yield* Effect.forEach(
        state.selections.flatMap(({ required, accounts }) =>
          accounts.map((account) => ({ account, provider: required.definition })),
        ),
        ({ account, provider }) =>
          Effect.all(
            [
              lifecycle === undefined ? Effect.void : lifecycle.accountResolving(account),
              options.accountUsable(account, provider),
            ],
            { concurrency: "unbounded", discard: true },
          ),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.provideService(CurrentProfile, state.profile));
  return {
    /**
     * Read `command` for this invocation state. `retain` keeps only results determined by these
     * inputs; a result that reflects a live publisher is never reused. `current` rejects a cached
     * value the caller knows is outdated, such as a skill revision it has already seen replaced.
     * `live` evaluates without reading or writing kept results, for callers that act on the
     * result, such as reconciling upstream webhook registrations.
     */
    read: <E>(
      command: string,
      state: InvocationSnapshot,
      evaluate: (context: Effect.Success<ReturnType<typeof resolve>>) => Effect.Effect<unknown, E>,
      policy: {
        readonly retain?: (value: unknown) => boolean;
        readonly current?: (value: unknown) => Effect.Effect<boolean>;
        readonly live?: boolean;
      } = {},
    ) =>
      Effect.gen(function* () {
        // Inputs are read no earlier than this; age counts from here, not from when an
        // evaluation, possibly a background one, finished.
        const started = yield* Clock.currentTimeMillis;
        const evaluated = resolve(state, options.resolveAccount, options.lifecycle).pipe(
          Effect.flatMap(evaluate),
        );
        if (policy.live === true) {
          yield* Effect.annotateCurrentSpan("executor.declarations.cache", "live");
          return yield* evaluated;
        }
        const id = yield* key(command, state);
        const load = Effect.gen(function* () {
          const value = yield* evaluated;
          if (policy.retain !== undefined && !policy.retain(value)) return value;
          const json = yield* Schema.encodeEffect(JsonText)(value).pipe(
            Effect.mapError(() => new StorageError()),
          );
          yield* options.cache.set(id, json, started);
          return value;
        });
        const cached = yield* options.cache.get(id);
        const age = cached === undefined ? Infinity : (yield* Clock.currentTimeMillis) - cached.at;
        if (cached === undefined || age >= declarationFreshness.maxStaleMillis) {
          yield* Effect.annotateCurrentSpan("executor.declarations.cache", "miss");
          return yield* load;
        }
        // A kept value this process cannot decode is replaced, never surfaced as a failure.
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
        if (stale && background === undefined) {
          yield* Effect.annotateCurrentSpan("executor.declarations.cache", "expired");
          return yield* load;
        }
        yield* authorize(state);
        yield* Effect.annotateCurrentSpan({
          "executor.declarations.cache": stale ? "stale" : "hit",
          "executor.declarations.age_ms": age,
        });
        if (stale && background !== undefined)
          // Claiming and handing over the refresh happen together, so an interrupted request
          // cannot leave a claim that no refresh will release.
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              if (!options.cache.claim(id, yield* Clock.currentTimeMillis)) return;
              const release = Effect.sync(() => options.cache.release(id));
              const accepted = yield* background(
                load.pipe(
                  Effect.timeout(declarationFreshness.refreshMillis),
                  Effect.catchCause(() => Effect.logWarning("Declaration refresh failed")),
                  Effect.asVoid,
                  Effect.ensuring(release),
                  Effect.withSpan("sdk.declarations.refresh"),
                ),
              );
              if (!accepted) yield* release;
            }),
          );
        return value;
      }).pipe(
        Effect.withSpan("sdk.declarations.read", {
          attributes: { "executor.declarations.command": command },
        }),
      ),
  };
};
export type Declarations = ReturnType<typeof makeDeclarations>;
