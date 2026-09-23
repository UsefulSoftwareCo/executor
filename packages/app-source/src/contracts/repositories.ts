/** Git adapter contracts. Repositories belong to existing app code identities. */
import { Effect, Schema } from "effect";
import { AppCodeId, SourceCommit, SourceError, SourceFiles } from "@executor-js/sdk/core";
export { AppCodeId, SourceError, SourceCommit as Commit } from "@executor-js/sdk/core";

/** Portable branch names, including the private retention prefix used by the source service. */
export const Branch = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9_][a-zA-Z0-9/_-]{0,127}$/),
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
/** Bounded UTF-8 source; generated dependency paths are legal in retained deployment snapshots. */
export const sourceFiles = (files: SourceFiles) =>
  sourceFits(
    files.length,
    files.reduce((size, file) => size + new TextEncoder().encode(file.content).length, 0),
  )
    ? Effect.succeed(files)
    : Effect.fail(new SourceError({ reason: "limit" }));

/** Platform mechanics only. App ownership and public package names do not belong here. */
export interface RepositoryBackend {
  readonly history: (
    id: AppCodeId,
  ) => Effect.Effect<ReadonlyArray<typeof GitCommit.Type>, SourceError>;
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
  readonly request: (id: AppCodeId, request: Request) => Effect.Effect<Response, SourceError>;
}
