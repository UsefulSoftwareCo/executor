/** Evaluated app declarations are dashboard metadata, served stale-while-revalidate. */
import type { Effect } from "effect";

/**
 * Ages count from when the read that produced a result began, which is no earlier than the
 * inputs it evaluated. A result younger than `freshMillis` is served as is. An older one is
 * served while one background evaluation replaces it. Past `maxStaleMillis` the read evaluates
 * again first. A background evaluation that runs longer than `refreshMillis` is stopped.
 */
export const declarationFreshness = {
  freshMillis: 10_000,
  maxStaleMillis: 60_000,
  refreshMillis: 30_000,
} as const;

/**
 * Memory bounds for one host process or isolate, in UTF-16 string bytes. A host creates one
 * store per process or isolate and shares it with every executor there. A larger result is
 * never retained.
 */
export const declarationLimits = {
  entries: 2_000,
  bytes: 16 * 1024 * 1024,
  entryBytes: 2 * 1024 * 1024,
} as const;

/**
 * Process or isolate memory of evaluated declarations. Keys digest every evaluation input.
 * Values are whatever the app returned, which can include text derived from credentials, so
 * they stay in this process and are never written to a shared or persistent store. `claim`
 * coordinates refreshes within one process.
 */
export interface DeclarationCache {
  readonly get: (
    key: string,
  ) => Effect.Effect<{ readonly json: string; readonly at: number } | undefined>;
  readonly set: (key: string, json: string, at: number) => Effect.Effect<void>;
  /** Claim the single background refresh of a key. False while a recent refresh is running. */
  readonly claim: (key: string, now: number) => boolean;
  readonly release: (key: string) => void;
}

/**
 * Starts work beside the current request and keeps it alive after the response, within the
 * host's lifetime for that request or server. It can share the request's resources, such as a
 * database connection. Succeeds with false when the host no longer accepts work, so the caller
 * can release what it reserved. Failures are the work's own responsibility.
 */
export type BackgroundWork = (work: Effect.Effect<void>) => Effect.Effect<boolean>;
