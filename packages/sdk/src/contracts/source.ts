/** Durable app source lives in a host-owned revision store, independently of SQL and builds. */
import { Effect, Schema } from "effect";
import { ApiError } from "@executor-js/utils/api-error";
import { AppCodeId, type AppId, type OwnerId, type StorageError } from "./shared.ts";
import type { AppNotFound } from "./apps.ts";

/**
 * Canonical relative POSIX path inside a deployment: no absolute paths,
 * backslashes, NUL bytes, or empty/`.`/`..` segments. Plain refined
 * strings — callers need not brand every path.
 */
export const SourceFilePath = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((path: string) => {
      if (path.includes("\0")) return "expected no NUL bytes";
      if (path.includes("\\")) return "expected POSIX separators";
      if (path.startsWith("/")) return "expected a relative path";
      return path.length > 0 && path.split("/").every((s) => s !== "" && s !== "." && s !== "..")
        ? true
        : "expected canonical segments (non-empty, no `.` or `..`)";
    }),
  ),
);

export type SourceFilePath = typeof SourceFilePath.Type;

/** One UTF-8 text file of a deployment. Content may be empty. */
export const SourceFile = Schema.Struct({ path: SourceFilePath, content: Schema.String });

export type SourceFile = typeof SourceFile.Type;

/**
 * A deployment's complete source: at least one file, unique paths, and a
 * root `index.ts` entrypoint. `package.json` is optional — the host
 * supplies `apps`, and extra dependencies may come from an
 * optional `package.json`. MCP/OpenAPI/GraphQL importers
 * emit ordinary files like these (their remote discovery still runs live at
 * evaluation); they are not special execution paths.
 */
export const SourceFiles = Schema.NonEmptyArray(SourceFile).pipe(
  Schema.check(
    Schema.makeFilter((files: ReadonlyArray<SourceFile>) =>
      new Set(files.map((f) => f.path)).size === files.length ? true : "expected unique paths",
    ),
    Schema.makeFilter((files: ReadonlyArray<SourceFile>) =>
      files.some((f) => f.path === "index.ts") ? true : "expected a root index.ts",
    ),
  ),
);

export type SourceFiles = typeof SourceFiles.Type;

/** File order is presentation; path and contents define source identity. */
export const sourceFilesEqual = (left: SourceFiles, right: SourceFiles): boolean => {
  if (left.length !== right.length) return false;
  const contents = new Map(left.map((file) => [file.path, file.content]));
  return right.every((file) => contents.get(file.path) === file.content);
};

/** A full immutable Git commit, never a mutable branch name. */
export const SourceCommit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
/** Source references keep the code lineage explicit so revisions cannot cross repositories. */
export const SourceRevision = Schema.Struct({ code: AppCodeId, commit: SourceCommit });
export type SourceRevision = typeof SourceRevision.Type;

/** Editable app source at one confirmed Git revision. */
export const SourceSnapshot = Schema.Struct({ revision: SourceRevision, files: SourceFiles });
export type SourceSnapshot = typeof SourceSnapshot.Type;

/** A saved commit. The caller already holds the files it sent, so they are not echoed back. */
export const CommittedSource = Schema.Struct({ revision: SourceRevision });
export type CommittedSource = typeof CommittedSource.Type;

const sourceFailures = {
  "not-found": "The requested app source revision does not exist.",
  conflict:
    "The app's source changed since it was read. Read the latest source, reapply the change, then commit against the new revision.",
  "invalid-source":
    "The app source is not valid: files must be UTF-8 text with supported paths and file modes.",
  git: "Executor's Git storage could not complete this source operation. Try again.",
  storage: "Executor could not read or write this app's source. Try again.",
  limit: "The app source exceeds Executor's file count or total size limit.",
  protected:
    "The app's Git history is protected from this change, such as deleting or recreating its main branch, or an unsupported push format.",
} as const;
/** Safe source failures; command output and remote credentials remain inside adapters. */
export const SourceError = ApiError.define({
  tag: "SourceError",
  status: 500,
  fields: {
    reason: Schema.Literals([
      "not-found",
      "conflict",
      "invalid-source",
      "git",
      "storage",
      "limit",
      "protected",
    ]),
  },
  message: ({ reason }) => sourceFailures[reason],
  recorded: ({ reason }) => sourceFailures[reason],
});
export type SourceError = typeof SourceError.Type;

/** Transport status follows the failure reason while preserving the SourceError domain value. */
export const sourceErrors = [
  SourceError.check(Schema.makeFilter((error) => error.reason === "conflict")).annotate({
    identifier: "SourceConflict",
    httpApiStatus: 409,
  }),
  SourceError.check(Schema.makeFilter((error) => error.reason === "not-found")).annotate({
    identifier: "SourceMissing",
    httpApiStatus: 404,
  }),
  SourceError.check(Schema.makeFilter((error) => error.reason === "protected")).annotate({
    identifier: "SourceProtected",
    httpApiStatus: 403,
  }),
  SourceError.check(Schema.makeFilter((error) => error.reason === "invalid-source")).annotate({
    identifier: "SourceInvalid",
    httpApiStatus: 400,
  }),
  SourceError.check(Schema.makeFilter((error) => error.reason === "limit")).annotate({
    identifier: "SourceLimit",
    httpApiStatus: 413,
  }),
  SourceError.check(
    Schema.makeFilter((error) => error.reason === "git" || error.reason === "storage"),
  ).annotate({ identifier: "SourceUnavailable", httpApiStatus: 503 }),
] as const;

/** Hosts must retain successful writes while any deployment or release references them. */
export interface AppSourceStorage {
  readonly retain: (
    code: AppCodeId,
    files: SourceFiles,
  ) => Effect.Effect<SourceRevision, SourceError>;
  readonly read: (revision: SourceRevision) => Effect.Effect<SourceFiles, SourceError>;
  readonly workspace: (code: AppCodeId) => Effect.Effect<SourceSnapshot | null, SourceError>;
  readonly commit: (input: {
    readonly code: AppCodeId;
    readonly expected: string | null;
    readonly files: SourceFiles;
    readonly message: string;
  }) => Effect.Effect<SourceSnapshot, SourceError>;
}

/** Portable branch names, including the private retention prefix used by the source service. */
export const Branch = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9_][a-zA-Z0-9/_-]{0,127}$/u),
  Schema.makeFilter((value) => !value.endsWith("/") && !value.includes("//")),
);
/** The source budget is identical for complete writes and incremental reads on every host. */
export const sourceLimits = { files: 4096, bytes: 16 * 1024 * 1024 } as const;
/** Reject invalid counters and stop readers before they accumulate an oversized source tree. */
export const sourceFits = (files: number, bytes: number): boolean =>
  Number.isSafeInteger(files) &&
  files >= 0 &&
  files <= sourceLimits.files &&
  Number.isSafeInteger(bytes) &&
  bytes >= 0 &&
  bytes <= sourceLimits.bytes;
/** Recent source history is metadata, separate from the files at each immutable revision. */
export const GitCommit = Schema.Struct({
  commit: SourceCommit,
  author: Schema.String,
  message: Schema.String,
  timestamp: Schema.Int,
});
export type GitCommit = typeof GitCommit.Type;
/** Bounded UTF-8 source; generated dependency paths are legal in retained deployment snapshots. */
export const sourceFiles = (files: SourceFiles) =>
  sourceFits(
    files.length,
    files.reduce((size, file) => size + new TextEncoder().encode(file.content).length, 0),
  )
    ? Effect.succeed(files)
    : Effect.fail(new SourceError({ reason: "limit" }));

/**
 * The Git backend a host supplies to `createExecutor`. Platform mechanics only: app ownership
 * and public package names never reach it. The executor derives its source storage from it.
 */
export interface RepositoryBackend {
  readonly history: (id: AppCodeId) => Effect.Effect<ReadonlyArray<GitCommit>, SourceError>;
  readonly create: (id: AppCodeId) => Effect.Effect<void, SourceError>;
  readonly head: (id: AppCodeId, branch: string) => Effect.Effect<string | null, SourceError>;
  /** Read one coherent snapshot; an absent branch fails with not-found, never another branch's files. */
  readonly read: (
    id: AppCodeId,
    ref: string,
  ) => Effect.Effect<{ readonly commit: string; readonly files: SourceFiles }, SourceError>;
  /** Create the repository for an initial write; existing writes must match the supplied revision. */
  readonly commit: (input: {
    readonly id: AppCodeId;
    readonly branch: string;
    readonly expected: string | null;
    readonly files: SourceFiles;
    readonly message: string;
  }) => Effect.Effect<typeof SourceCommit.Type, SourceError>;
  /** Serve one Git smart-HTTP request against the repository. */
  readonly request: (id: AppCodeId, request: Request) => Effect.Effect<Response, SourceError>;
}

/** Git protocol access is host-only, outside the public HTTP/Promise facade. */
export const RepositoryHost = Symbol("executor.RepositoryHost");
/** Hosts authorize the caller and then hand the raw Git request to the app's repository. */
export interface RepositoryHost {
  readonly request: (
    input: { readonly app: AppId; readonly owner?: OwnerId | undefined },
    request: Request,
  ) => Effect.Effect<Response, SourceError | AppNotFound | StorageError>;
  /** Retry pending repository creation with bounded parallel work. */
  readonly recover: Effect.Effect<void, StorageError>;
}
