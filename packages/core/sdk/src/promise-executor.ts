// ---------------------------------------------------------------------------
// @executor-js/sdk/promise — thin Promise façade over the Effect SDK.
//
// Consumer goal: use executors + plugins without touching Effect. The
// façade wraps `createExecutor` so it returns a Promise, and proxies
// every method on the returned executor to unwrap its Effect into a
// Promise. Plugin factories are Effect-native but consumers never see
// that — the proxy flattens plugin extension methods too.
//
// Not a goal: authoring plugins in Promise style. The plugin model
// (storage, schema, staticSources, Effect ctx) is Effect-only. Bring
// your own `@executor-js/plugin-*` from the Effect side.
// ---------------------------------------------------------------------------

import { Brand, Effect } from "effect";

import {
  collectTables,
  createExecutor as createEffectExecutor,
  type Executor as EffectExecutor,
  type InvokeOptions as EffectInvokeOptions,
  type OnElicitation,
} from "./executor";
import type { ElicitationContext, ElicitationResponse } from "./elicitation";
import type { FumaDb, FumaTables } from "./fuma-runtime";
import { Subject, Tenant } from "./ids";
import type { AnyPlugin } from "./plugin";
import type { CredentialProvider } from "./provider";

// ---------------------------------------------------------------------------
// Types
//
// Promise consumers shouldn't need to construct Effect `Brand`s to call into
// the executor — branded ids (`SecretId`, `ScopeId`, `ToolId`, `PolicyId`,
// `ConnectionId`) are typed as `string & Brand<...>` on the Effect side, but
// at runtime they're plain strings. `Unbrand` strips brand tags from
// parameter types (recursively, so it walks into object fields like
// `secrets.set({ id, scope })`) so consumers can pass plain strings. Return
// types are passed through unchanged — caller code that reads `.id` etc.
// off a returned ref still gets the branded type for use as an opaque token.
// ---------------------------------------------------------------------------

type Unbrand<T> =
  T extends Brand.Brand<string>
    ? string
    : T extends readonly (infer U)[]
      ? readonly Unbrand<U>[]
      : T extends ReadonlyMap<infer K, infer V>
        ? ReadonlyMap<Unbrand<K>, Unbrand<V>>
        : T extends ReadonlySet<infer U>
          ? ReadonlySet<Unbrand<U>>
          : T extends Date
            ? T
            : T extends (...args: infer A) => infer R
              ? (...args: { [I in keyof A]: Unbrand<A[I]> }) => Unbrand<R>
              : T extends object
                ? { readonly [K in keyof T]: Unbrand<T[K]> }
                : T;

export type PromiseOnElicitation =
  | "accept-all"
  | ((ctx: Unbrand<ElicitationContext>) => ElicitationResponse | Promise<ElicitationResponse>);

export interface PromiseInvokeOptions {
  readonly onElicitation?: PromiseOnElicitation;
}

type PromisifiedArg<T> = T extends EffectInvokeOptions | undefined
  ? PromiseInvokeOptions | undefined
  : Unbrand<T>;

type PromisifiedArgs<TArgs extends readonly unknown[]> = {
  [I in keyof TArgs]: PromisifiedArg<TArgs[I]>;
};

export type Promisified<T> = T extends (...args: infer A) => Effect.Effect<infer R, infer _E>
  ? (...args: PromisifiedArgs<A>) => Promise<R>
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { readonly [K in keyof T]: Promisified<T[K]> }
      : T;

export type Executor<TPlugins extends readonly AnyPlugin[] = readonly []> = Promisified<
  EffectExecutor<TPlugins>
>;

export interface ExecutorConfig<TPlugins extends readonly AnyPlugin[] = readonly []> {
  /** The org / workspace this executor binds to. Optional — defaults to
   *  `"default-tenant"`. `owner: "org"` rows file here. */
  readonly tenant?: string;
  /** The acting member. Omit for a pure-org executor (no `owner:"user"`). */
  readonly subject?: string;
  readonly plugins?: TPlugins;
  /**
   * Config-level credential providers, merged with every
   * `plugin.credentialProviders`. Config providers register first, so the
   * default (first writable) store is selected from them when present. A
   * writable provider is required before `connections.create({ value })` can
   * store an inline credential. Providers are Effect-native objects (their
   * `get`/`set` return `Effect`s) — bring them from `@executor-js/sdk/core`.
   */
  readonly providers?: readonly CredentialProvider[];
  /**
   * FumaDB ORM handle, or a factory that receives the executor-owned table
   * map. Public consumers usually want the factory form so `collectTables()`
   * stays inside `createExecutor`.
   */
  readonly db?:
    | FumaDb
    | { readonly db: FumaDb; readonly close?: () => Promise<void> | void }
    | ((config: { readonly tables: FumaTables }) =>
        | FumaDb
        | { readonly db: FumaDb; readonly close?: () => Promise<void> | void }
        | Promise<
            | FumaDb
            | {
                readonly db: FumaDb;
                readonly close?: () => Promise<void> | void;
              }
          >);
  /**
   * How to respond when a tool requests user input mid-invocation. Pass
   * `"accept-all"` for tests / non-interactive hosts, or a handler
   * `(ctx) => Promise<ElicitationResponse>` for interactive ones.
   * Required at construction so per-invoke calls don't have to thread
   * an options arg.
   */
  readonly onElicitation: PromiseOnElicitation;
}

// ---------------------------------------------------------------------------
// Promisify proxy — walks nested objects, converts Effect-returning methods
// into Promise-returning methods. Non-Effect return values pass through.
// ---------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string | symbol, unknown> =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  !(v instanceof Promise);

const isPromiseOnElicitation = (value: unknown): value is PromiseOnElicitation =>
  value === "accept-all" || typeof value === "function";

const toEffectOnElicitation = (handler: PromiseOnElicitation): OnElicitation =>
  handler === "accept-all"
    ? "accept-all"
    : (ctx) => Effect.promise(() => Promise.resolve(handler(ctx)));

const adaptPromiseInvokeOptions = (value: unknown): unknown => {
  if (!isPlainObject(value) || !Object.hasOwn(value, "onElicitation")) return value;
  const onElicitation = value.onElicitation;
  if (onElicitation === undefined || !isPromiseOnElicitation(onElicitation)) return value;
  return {
    ...value,
    onElicitation: toEffectOnElicitation(onElicitation),
  };
};

const adaptPromiseArgs = (args: readonly unknown[]): unknown[] =>
  args.map((arg) => adaptPromiseInvokeOptions(arg));

const promisifyDeep = <T>(value: T): Promisified<T> => {
  if (typeof value === "function") {
    return ((...args: unknown[]) => {
      const result = (value as (...a: unknown[]) => unknown).apply(
        undefined,
        adaptPromiseArgs(args),
      );
      if (Effect.isEffect(result)) {
        return Effect.runPromise(result as Effect.Effect<unknown, unknown>);
      }
      return result;
    }) as Promisified<T>;
  }

  if (!isPlainObject(value)) return value as Promisified<T>;

  return new Proxy(value, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v === "function") {
        return (...args: unknown[]) => {
          const result = (v as (...a: unknown[]) => unknown).apply(target, adaptPromiseArgs(args));
          if (Effect.isEffect(result)) {
            return Effect.runPromise(result as Effect.Effect<unknown, unknown>);
          }
          return result;
        };
      }
      if (isPlainObject(v)) return promisifyDeep(v);
      return v;
    },
  }) as Promisified<T>;
};

// ---------------------------------------------------------------------------
// createExecutor — Promise wrapper over the Effect createExecutor.
// ---------------------------------------------------------------------------

export const createExecutor = async <const TPlugins extends readonly AnyPlugin[] = readonly []>(
  config: ExecutorConfig<TPlugins>,
): Promise<Executor<TPlugins>> => {
  const plugins = (config?.plugins ?? []) as TPlugins;
  const db =
    typeof config.db === "function" ? await config.db({ tables: collectTables() }) : config.db;

  const effectConfig = {
    tenant: Tenant.make(config.tenant ?? "default-tenant"),
    ...(config.subject !== undefined ? { subject: Subject.make(config.subject) } : {}),
    plugins,
    ...(config.providers ? { providers: config.providers } : {}),
    onElicitation: toEffectOnElicitation(config.onElicitation),
    ...(db ? { db } : {}),
  };

  // The SDK has no observability requirement; storage failures surface
  // as raw `StorageError` / `UniqueViolationError` in the typed channel.
  // `Effect.runPromise` turns them into Promise rejections — consumers
  // get the tagged error as the rejected value. See
  // notes/promise-sdk-typed-errors.md for the planned `runPromiseExit`
  // rewrite that exposes the full error union to consumers.
  const effectExecutor = await Effect.runPromise(createEffectExecutor(effectConfig));

  const executor = promisifyDeep(effectExecutor) as Executor<TPlugins>;
  return {
    ...executor,
    close: async () => {
      await Effect.runPromise(effectExecutor.close());
    },
  } as Executor<TPlugins>;
};
