import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import {
  ArtifactStoreError,
  asSnapshotId,
  type ArtifactStore,
  type FileSet,
  type ScopeArtifactStore,
  type SnapshotId,
  type SnapshotMeta,
} from "../seams/artifact-store";
import { scopeAddressStorageKey } from "../seams/scope-address";

// ---------------------------------------------------------------------------
// Git-backed ArtifactStore (self-hosted). One bare git repo per scope under
// `<root>/<scope>.git`. Snapshots are commits, written via git plumbing
// (hash-object -> update-index -> write-tree -> commit-tree) so no working tree
// is ever checked out — the runtime only reads committed snapshots. The commit
// hash IS the SnapshotId; git guarantees immutability (content-addressed).
// ---------------------------------------------------------------------------

const BRANCH = "refs/heads/main";

// The "must not exist" sentinel for `git update-ref <ref> <new> <old>`: an empty
// old-value asserts the ref currently has NO value (the first publish to a fresh
// scope repo). git treats the empty string as "the ref must not already exist".
const EMPTY_OID = "";

const run = (
  cwd: string,
  args: readonly string[],
  input?: string | Buffer,
): Effect.Effect<string, ArtifactStoreError> =>
  Effect.callback<string, ArtifactStoreError>((resume) => {
    const child = execFile(
      "git",
      args,
      { cwd, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error) {
          resume(
            Effect.fail(
              new ArtifactStoreError({
                message: `git ${args[0]} failed: ${(stderr as Buffer)?.toString() || error.message}`,
                cause: error,
              }),
            ),
          );
          return;
        }
        resume(Effect.succeed((stdout as Buffer).toString("utf8")));
      },
    );
    if (input !== undefined) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });

const makeScopeStore = (repoDir: string): ScopeArtifactStore => {
  // Environment forcing a deterministic author/committer so a snapshot's hash
  // depends only on its content + parent, not on wall-clock/identity drift.
  const commitEnv = (message: string) =>
    Effect.gen(function* () {
      const parent = yield* headCommit();
      // Build a tree from the provided file set held in a bare index file.
      return { parent, message };
    });

  const headCommit = (): Effect.Effect<string | null, ArtifactStoreError> =>
    run(repoDir, ["rev-parse", "--verify", "--quiet", BRANCH]).pipe(
      Effect.map((out) => out.trim() || null),
      Effect.catch(() => Effect.succeed(null)),
    );

  const readMeta = (id: string): Effect.Effect<SnapshotMeta, ArtifactStoreError> =>
    run(repoDir, ["show", "-s", "--format=%H%n%ct%n%s", id]).pipe(
      Effect.map((out) => {
        const [hash, committed, ...subjectParts] = out.split("\n");
        return {
          id: asSnapshotId(hash.trim()),
          committedAt: Number(committed.trim()) * 1000,
          message: subjectParts.join("\n").trim(),
        } satisfies SnapshotMeta;
      }),
    );

  return {
    commit: (files: FileSet, message: string) =>
      Effect.gen(function* () {
        const { parent } = yield* commitEnv(message);
        // Use a throwaway index so we never touch a working tree.
        const indexFile = join(
          repoDir,
          `commit-index-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        const withIndex = (args: readonly string[], input?: string | Buffer) =>
          Effect.callback<string, ArtifactStoreError>((resume) => {
            const child = execFile(
              "git",
              args,
              {
                cwd: repoDir,
                maxBuffer: 256 * 1024 * 1024,
                encoding: "buffer",
                env: { ...process.env, GIT_INDEX_FILE: indexFile },
              },
              (error, stdout, stderr) => {
                if (error) {
                  resume(
                    Effect.fail(
                      new ArtifactStoreError({
                        message: `git ${args[0]} failed: ${(stderr as Buffer)?.toString() || error.message}`,
                        cause: error,
                      }),
                    ),
                  );
                  return;
                }
                resume(Effect.succeed((stdout as Buffer).toString("utf8")));
              },
            );
            if (input !== undefined) {
              child.stdin?.write(input);
              child.stdin?.end();
            }
          });

        // Start from an empty index each publish (full file set, not a diff).
        yield* withIndex(["read-tree", "--empty"]);
        for (const [path, contents] of files) {
          const blobHash = (yield* withIndex(
            ["hash-object", "-w", "--stdin"],
            Buffer.from(contents, "utf8"),
          )).trim();
          yield* withIndex(["update-index", "--add", "--cacheinfo", `100644,${blobHash},${path}`]);
        }
        const treeHash = (yield* withIndex(["write-tree"])).trim();
        const commitArgs = ["commit-tree", treeHash, "-m", message];
        if (parent) commitArgs.push("-p", parent);
        const commitEnvVars = {
          ...process.env,
          GIT_AUTHOR_NAME: "executor-apps",
          GIT_AUTHOR_EMAIL: "apps@executor.local",
          GIT_COMMITTER_NAME: "executor-apps",
          GIT_COMMITTER_EMAIL: "apps@executor.local",
        };
        const commitHash = (yield* Effect.callback<string, ArtifactStoreError>((resume) => {
          execFile(
            "git",
            commitArgs,
            { cwd: repoDir, encoding: "buffer", env: commitEnvVars },
            (error, stdout, stderr) => {
              if (error) {
                resume(
                  Effect.fail(
                    new ArtifactStoreError({
                      message: `git commit-tree failed: ${(stderr as Buffer)?.toString() || error.message}`,
                      cause: error,
                    }),
                  ),
                );
                return;
              }
              resume(Effect.succeed((stdout as Buffer).toString("utf8")));
            },
          );
        })).trim();
        // Compare-and-swap the branch ref: `update-ref <ref> <new> <old>` fails
        // if HEAD moved since we read `parent`, so a concurrent publish that
        // committed first cannot be silently clobbered. On the first commit there
        // is no parent, so we assert the ref is absent (the empty-oid form). A CAS
        // failure surfaces as a typed conflict for the caller to retry from a
        // fresh parent.
        const expectedOld = parent ?? EMPTY_OID;
        yield* run(repoDir, ["update-ref", BRANCH, commitHash, expectedOld]).pipe(
          Effect.mapError(
            (cause) =>
              new ArtifactStoreError({
                message: `publish conflict: ${BRANCH} moved concurrently (expected ${expectedOld}); retry from the new head`,
                conflict: true,
                cause,
              }),
          ),
        );
        return yield* readMeta(commitHash);
      }),

    read: (id: SnapshotId) =>
      run(repoDir, ["ls-tree", "-r", "--name-only", id]).pipe(
        Effect.flatMap((out) => {
          const paths = out
            .split("\n")
            .map((p) => p.trim())
            .filter(Boolean);
          return Effect.forEach(
            paths,
            (path) =>
              run(repoDir, ["cat-file", "blob", `${id}:${path}`]).pipe(
                Effect.map((contents) => [path, contents] as const),
              ),
            { concurrency: 8 },
          );
        }),
        Effect.map((entries) => new Map(entries) as FileSet),
      ),

    readFile: (id: SnapshotId, path: string) =>
      run(repoDir, ["cat-file", "blob", `${id}:${path}`]).pipe(
        Effect.map((contents) => contents as string | null),
        Effect.catch(() => Effect.succeed(null)),
      ),

    list: (id: SnapshotId) =>
      run(repoDir, ["ls-tree", "-r", "--name-only", id]).pipe(
        Effect.map((out) =>
          out
            .split("\n")
            .map((p) => p.trim())
            .filter(Boolean),
        ),
      ),

    latest: () =>
      headCommit().pipe(Effect.flatMap((head) => (head ? readMeta(head) : Effect.succeed(null)))),

    log: (limit = 50) =>
      headCommit().pipe(
        Effect.flatMap((head) => {
          if (!head) return Effect.succeed([] as readonly SnapshotMeta[]);
          return run(repoDir, [
            "log",
            `--max-count=${limit}`,
            "--format=%H%x1f%ct%x1f%s",
            BRANCH,
          ]).pipe(
            Effect.map((out) =>
              out
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                  const [hash, committed, subject] = line.split("\x1f");
                  return {
                    id: asSnapshotId(hash),
                    committedAt: Number(committed) * 1000,
                    message: subject ?? "",
                  } satisfies SnapshotMeta;
                }),
            ),
          );
        }),
      ),
  };
};

export interface GitArtifactStoreOptions {
  /** Directory holding one bare repo per tenant/scope. Created on demand. */
  readonly root: string;
}

/** Build the git-backed ArtifactStore. Each tenant/scope pair gets a
 *  lazily-initialized bare repo under `<root>`. */
export const makeGitArtifactStore = (options: GitArtifactStoreOptions): ArtifactStore => {
  const initialized = new Map<string, Promise<ScopeArtifactStore>>();

  const init = async (key: string): Promise<ScopeArtifactStore> => {
    const repoDir = join(options.root, `${key}.git`);
    await mkdir(repoDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["init", "--bare", "--quiet"], { cwd: repoDir }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    return makeScopeStore(repoDir);
  };

  return {
    forScope: (address) =>
      Effect.tryPromise({
        try: () => {
          const key = scopeAddressStorageKey(address);
          let existing = initialized.get(key);
          if (!existing) {
            existing = init(key);
            initialized.set(key, existing);
          }
          return existing;
        },
        catch: (cause) =>
          new ArtifactStoreError({
            message: `failed to open scope repo: ${address.tenant}/${address.scope}`,
            cause,
          }),
      }),
  };
};
