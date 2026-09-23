/** Explicit ephemeral source adapter for isolated SDK fixtures. Hosts use durable Git adapters. */
import { Effect } from "effect";
import { SourceError, type AppSourceStorage } from "./contracts/source.ts";
import type { SourceFiles } from "./contracts/deployment.ts";

/** Each fixture owns its source revisions; reuse this instance when testing executor restarts. */
export const memorySourceStorage = (): AppSourceStorage => {
  const snapshots = new Map<string, SourceFiles>();
  const heads = new Map<string, string>();
  const adapter: AppSourceStorage = {
    retain: (code, files) =>
      Effect.gen(function* () {
        const copy = structuredClone(files);
        const commit = yield* Effect.promise(async () =>
          Array.from(
            new Uint8Array(
              await crypto.subtle.digest("SHA-1", new TextEncoder().encode(JSON.stringify(copy))),
            ),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join(""),
        );
        snapshots.set(`${code}/${commit}`, copy);
        return { code, commit };
      }),
    workspace: (code) =>
      Effect.gen(function* () {
        const commit = heads.get(code);
        return commit === undefined
          ? null
          : { revision: { code, commit }, files: yield* adapter.read({ code, commit }) };
      }),
    commit: (input) =>
      Effect.gen(function* () {
        if ((heads.get(input.code) ?? null) !== input.expected)
          return yield* new SourceError({ reason: "conflict" });
        const revision = yield* adapter.retain(input.code, input.files);
        heads.set(input.code, revision.commit);
        return { revision, files: input.files };
      }),
    read: ({ code, commit }) =>
      Effect.suspend(() => {
        const files = snapshots.get(`${code}/${commit}`);
        return files === undefined
          ? Effect.fail(new SourceError({ reason: "not-found" }))
          : Effect.succeed(structuredClone(files));
      }),
  };
  return adapter;
};
