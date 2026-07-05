import { Effect } from "effect";

import type { AppDescriptor } from "../pipeline/descriptor";
import type { AppsStore } from "../plugin/store";
import type { ClientResolver, BindingError } from "../plugin/bindings";

// ---------------------------------------------------------------------------
// Test helpers: an in-memory AppsStore and a canned ClientResolver, plus the
// daily-brief fixture set. Used by the runtime integration test and the e2e.
// ---------------------------------------------------------------------------

export * from "./daily-brief";

/** In-memory AppsStore (descriptors + blobs in Maps). */
export const makeInMemoryAppsStore = (): AppsStore & {
  readonly blobs: Map<string, string>;
  readonly descriptors: Map<string, AppDescriptor>;
} => {
  const descriptors = new Map<string, AppDescriptor>();
  const blobs = new Map<string, string>();
  return {
    descriptors,
    blobs,
    putDescriptor: (_owner, descriptor) =>
      Effect.sync(() => void descriptors.set(descriptor.scope, descriptor)),
    getDescriptor: (scope) => Effect.sync(() => descriptors.get(scope) ?? null),
    putBlob: (key, value) => Effect.sync(() => void blobs.set(key, value)),
    getBlob: (key) => Effect.sync(() => blobs.get(key) ?? null),
  };
};

/** A resolver that dispatches integration method calls to supplied handlers.
 *  `handlers[integration][path.join(".")]` returns the JSON result. */
export const makeTestResolver = (
  handlers: Record<string, Record<string, (args: readonly unknown[]) => unknown>>,
): ClientResolver & {
  readonly calls: { integration: string; connection: string; method: string }[];
} => {
  const calls: { integration: string; connection: string; method: string }[] = [];
  return {
    calls,
    call: ({ integration, connection, path, args }) => {
      const method = path.join(".");
      calls.push({ integration, connection, method });
      const handler = handlers[integration]?.[method];
      if (!handler) {
        return Effect.fail({
          _tag: "BindingError",
          message: `no test handler for ${integration}.${method}`,
          role: integration,
          surface: integration,
        } as unknown as BindingError);
      }
      return Effect.sync(() => handler(args));
    },
  };
};
