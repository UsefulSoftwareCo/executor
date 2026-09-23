/** Git source storage shared by local, self-host, and cloud apps. */
import { Effect } from "effect";
import {
  SourceError,
  SourceRevision,
  type AppSourceStorage,
  type SourceFiles,
} from "@executor-js/sdk/core";
import type { RepositoryBackend } from "./contracts/repositories.ts";
export * from "./contracts/repositories.ts";

/** Stable file ordering makes retries and migration comparisons independent of input order. */
export const encodeSource = (files: SourceFiles) =>
  new TextEncoder().encode(
    JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))),
  );

/** Each protected ref pins a complete snapshot; ordinary Git pushes cannot change it. */
export const gitSourceStorage = (repositories: RepositoryBackend): AppSourceStorage => ({
  workspace: (code) =>
    repositories.read(code, "main").pipe(
      Effect.map((snapshot) => ({
        revision: { code, commit: snapshot.commit },
        files: snapshot.files,
      })),
      Effect.catchTag("SourceError", (error) =>
        error.reason === "not-found" ? Effect.succeed(null) : Effect.fail(error),
      ),
      Effect.withSpan("source.workspace.read"),
    ),
  commit: (input) =>
    Effect.gen(function* () {
      const commit = yield* repositories.commit({
        id: input.code,
        branch: "main",
        expected: input.expected,
        files: input.files,
        message: input.message,
      });
      return { revision: { code: input.code, commit }, files: input.files };
    }),
  read: ({ code, commit }) =>
    repositories.read(code, commit).pipe(Effect.map((snapshot) => snapshot.files)),
  retain: (code, files) =>
    Effect.gen(function* () {
      const bytes = encodeSource(files);
      const hash = yield* Effect.tryPromise({
        try: async () =>
          Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        catch: () => new SourceError({ reason: "storage" }),
      });
      yield* repositories.create(code);
      const branch = `__executor/sources/${hash}`;
      const existing = yield* repositories.head(code, branch);
      const commit =
        existing ??
        (yield* repositories
          .commit({ id: code, branch, expected: null, files, message: "Retain app source" })
          .pipe(
            Effect.catchTag("SourceError", (error) =>
              error.reason === "conflict"
                ? repositories
                    .head(code, branch)
                    .pipe(
                      Effect.flatMap((commit) =>
                        commit === null ? Effect.fail(error) : Effect.succeed(commit),
                      ),
                    )
                : Effect.fail(error),
            ),
          ));
      const retained = yield* repositories.read(code, commit);
      const actual = encodeSource(retained.files);
      if (actual.length !== bytes.length || !actual.every((byte, index) => byte === bytes[index]))
        return yield* new SourceError({ reason: "storage" });
      return SourceRevision.make({ code, commit });
    }),
});
