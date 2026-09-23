/** Durable app source lives in a host-owned revision store, independently of SQL and builds. */
import { Schema, type Effect } from "effect";
import { AppCodeId } from "./shared.ts";

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
export const SourceCommit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
/** Source references keep the code lineage explicit so revisions cannot cross repositories. */
export const SourceRevision = Schema.Struct({ code: AppCodeId, commit: SourceCommit });
export type SourceRevision = typeof SourceRevision.Type;

/** Editable app source at one confirmed Git revision. */
export const SourceSnapshot = Schema.Struct({ revision: SourceRevision, files: SourceFiles });
export type SourceSnapshot = typeof SourceSnapshot.Type;

/** Safe source failures; command output and remote credentials remain inside adapters. */
export class SourceError extends Schema.TaggedError<SourceError>()("SourceError", {
  reason: Schema.Literals([
    "not-found",
    "conflict",
    "invalid-source",
    "git",
    "storage",
    "limit",
    "protected",
  ]),
}) {}

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
