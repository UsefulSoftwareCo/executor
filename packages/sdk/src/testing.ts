/** Explicit ephemeral adapters for isolated SDK fixtures. Hosts use durable Git and catalogs. */
import { Effect } from "effect";
import { SourceError, type RepositoryBackend } from "./contracts/source.ts";
import type { SourceFiles } from "./contracts/deployment.ts";
import { RegistryError, type Registry } from "./contracts/registry.ts";

/** Each fixture owns its revisions; reuse this instance when testing executor restarts. */
export const memoryRepositories = (): RepositoryBackend => {
  const snapshots = new Map<string, SourceFiles>();
  const heads = new Map<string, string>();
  const log = new Map<string, { commit: string; message: string; timestamp: number }[]>();
  const key = (id: string, branch: string) => `${id}\n${branch}`;
  const hash = (files: SourceFiles) =>
    Effect.promise(async () =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-1", new TextEncoder().encode(JSON.stringify(files))),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join(""),
    );
  const adapter: RepositoryBackend = {
    create: () => Effect.void,
    head: (id, branch) => Effect.sync(() => heads.get(key(id, branch)) ?? null),
    history: (id) =>
      Effect.sync(() =>
        (log.get(key(id, "main")) ?? []).map((entry) => ({ ...entry, author: "fixture" })),
      ),
    read: (id, ref) =>
      Effect.suspend(() => {
        const commit = heads.get(key(id, ref)) ?? ref;
        const files = snapshots.get(`${id}/${commit}`);
        return files === undefined
          ? Effect.fail(new SourceError({ reason: "not-found" }))
          : Effect.succeed({ commit, files: structuredClone(files) });
      }),
    commit: (input) =>
      Effect.gen(function* () {
        const branch = key(input.id, input.branch);
        if ((heads.get(branch) ?? null) !== input.expected)
          return yield* new SourceError({ reason: "conflict" });
        const copy = structuredClone(input.files);
        const commit = yield* hash(copy);
        snapshots.set(`${input.id}/${commit}`, copy);
        heads.set(branch, commit);
        log.set(branch, [
          { commit, message: input.message, timestamp: Date.now() },
          ...(log.get(branch) ?? []),
        ]);
        return commit;
      }),
    request: () => Effect.fail(new SourceError({ reason: "git" })),
  };
  return adapter;
};

/** An empty remote catalog for fixtures that never publish or install public apps. */
export const memoryRegistry = (): Registry => ({
  origin: "https://registry.invalid",
  list: () => Effect.succeed([]),
  snapshot: () => Effect.fail(new RegistryError({ reason: "not-found" })),
});
