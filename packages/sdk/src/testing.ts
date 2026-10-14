/** Explicit ephemeral adapters for isolated SDK fixtures. Hosts use durable Git and catalogs. */
import { Effect } from "effect";
import {
  encodeBase64,
  inlineBytes,
  isUpload,
  removedPaths,
  SourceError,
  type RepositoryBackend,
  type SourceFile,
} from "./contracts/source.ts";

type SourceFiles = readonly [SourceFile, ...SourceFile[]];
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
        const previous =
          input.expected === null ? [] : (snapshots.get(`${input.id}/${input.expected}`) ?? []);
        // Uploads are kept inline; stored files keep the entry the caller read.
        const kept: SourceFile[] = [];
        for (const file of input.files)
          kept.push(
            isUpload(file)
              ? { path: file.path, content: encodeBase64(yield* file.read), encoding: "base64" }
              : structuredClone(file),
          );
        const [first, ...rest] = kept;
        if (first === undefined) return yield* new SourceError({ reason: "invalid-source" });
        const copy: SourceFiles = [first, ...rest];
        const commit = yield* hash(copy);
        snapshots.set(`${input.id}/${commit}`, copy);
        heads.set(branch, commit);
        log.set(branch, [
          { commit, message: input.message, timestamp: Date.now() },
          ...(log.get(branch) ?? []),
        ]);
        return {
          commit,
          removed: removedPaths(
            previous.map((file) => file.path),
            input.files,
          ),
        };
      }),
    // Fixture saves keep every file inline, so no read lists a blob.
    blob: () => Effect.fail(new SourceError({ reason: "not-found" })),
    file: (id, commit, path) =>
      Effect.suspend(() => {
        const found = snapshots.get(`${id}/${commit}`)?.find((file) => file.path === path);
        return found === undefined || "object" in found
          ? Effect.fail(new SourceError({ reason: "not-found" }))
          : Effect.succeed(inlineBytes(found));
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
  file: () => Effect.fail(new RegistryError({ reason: "not-found" })),
  files: () => Effect.fail(new RegistryError({ reason: "not-found" })),
});
