/** Author cache API; schemas parse persisted values before they re-enter app code. */
import type { Duration, Effect } from "effect";
import type { CacheTransport } from "@executor-js/app-cache/contracts";
import type { Schema } from "../implementation/schema.ts";
import type { JsonValue } from "./schema.ts";

/** A cache loader owns its own cancellation and HTTP capability, including during SWR. */
export interface CacheLoadContext {
  readonly cache: AppCache;
  readonly signal: AbortSignal;
  readonly fetch: typeof globalThis.fetch;
}
/** Load options shared by normal reads and explicit refreshes. */
export interface CacheGetOptions<A> {
  readonly key: JsonValue;
  readonly schema: Schema<A, boolean>;
  readonly freshFor: Duration.Input;
  readonly staleFor?: Duration.Input;
  /**
   * Past `freshFor`, `serve` (the default) returns the kept value while `load` replaces it in the
   * background. `revalidate` awaits `load` first; the kept value stays readable with `read`, so
   * the loader can confirm it with the source instead of rebuilding it.
   */
  readonly stale?: "serve" | "revalidate";
  readonly load: (context: CacheLoadContext) => Promise<A>;
}
/** Cache keys describe every input that affects the value; the host adds app/build isolation. */
export interface AppCache {
  readonly get: <A>(options: CacheGetOptions<A>) => Promise<A>;
  /** Await a fresh load, coalescing concurrent refreshes and retaining the previous value on failure. */
  readonly revalidate: <A>(options: CacheGetOptions<A>) => Promise<A>;
  readonly read: <A>(key: JsonValue, schema: Schema<A, boolean>) => Promise<A | undefined>;
  readonly readMany: <A>(
    keys: readonly JsonValue[],
    schema: Schema<A, boolean>,
  ) => Promise<readonly (A | undefined)[]>;
  readonly write: (
    entries: readonly { readonly key: JsonValue; readonly value: JsonValue }[],
    retention: Duration.Input,
  ) => Promise<void>;
  readonly invalidate: (key: JsonValue) => Promise<void>;
  /**
   * Scope entries to a bound account and its credential generation. Token renewal keeps the
   * entries; reconnecting or replacing the account's credentials starts an empty scope.
   */
  readonly forAccount: (account: { readonly id: string }) => AppCache;
}

/**
 * A credential a remote read sends, and the account it belongs to. A public source takes neither.
 * A credential comes only with its account, so the read is cached in that account's scope.
 */
export type AccountCredential<Credential extends object> =
  | ({ readonly account?: undefined } & { readonly [Field in keyof Credential]?: undefined })
  | ({
      /** The selected account, as `accounts.<slot>` provides it. */
      readonly account: { readonly id: string };
    } & Credential);

/** Trusted storage and background ownership; never accepted from request JSON. */
export interface HostCache {
  readonly transport: CacheTransport;
  readonly background: (task: Effect.Effect<void, unknown>) => Effect.Effect<void>;
}
