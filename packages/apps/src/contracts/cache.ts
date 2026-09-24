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
/** Cache keys describe every input that affects the value; the host adds app/build isolation. */
export interface AppCache {
  readonly get: <A>(options: {
    readonly key: JsonValue;
    readonly schema: Schema<A, boolean>;
    readonly freshFor: Duration.Input;
    readonly staleFor?: Duration.Input;
    readonly load: (context: CacheLoadContext) => Promise<A>;
  }) => Promise<A>;
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
  /** Uses the current bound credentials' fingerprint, never just the saved account ID. */
  readonly forAccount: (account: { readonly id: string }) => AppCache;
}

/** Trusted storage and background ownership; never accepted from request JSON. */
export interface HostCache {
  readonly transport: CacheTransport;
  readonly background: (task: Effect.Effect<void, unknown>) => Effect.Effect<void>;
}
