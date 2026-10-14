/** Server-only Artifacts credentials. The host owns persistence and refresh coordination. */
import type { Effect, Redacted } from "effect";
import type { AppCodeId, GitCommit, SourceError } from "@executor-js/sdk/core";

/** A generation identifies the exact credential rejected by Git without transmitting it again. */
export interface ArtifactsToken {
  readonly generation: string;
  readonly token: Redacted.Redacted<string>;
}

/** Repository creation starts credential preparation without awaiting token issuance. */
export interface ArtifactsTokens {
  readonly create: (
    repository: AppCodeId,
  ) => Effect.Effect<Redacted.Redacted<string> | null, SourceError>;
  /** Reuse a valid token, or replace the rejected generation once across concurrent callers. */
  readonly acquire: (
    repository: AppCodeId,
    rejectedGeneration: string | null,
  ) => Effect.Effect<ArtifactsToken, SourceError>;
  /**
   * Up to `limit` commits of main, newest first along its first-parent chain, read through the
   * Artifacts binding. Git cannot list history without fetching every file those commits hold.
   */
  readonly history: (
    repository: AppCodeId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<GitCommit>, SourceError>;
  /** A branch's head commit, or a commit by SHA, and its root tree; null when there is none. */
  readonly resolve: (
    repository: AppCodeId,
    ref: string,
  ) => Effect.Effect<{ readonly commit: string; readonly tree: string } | null, SourceError>;
  /** Every entry below a tree, read through the binding without reading any file. */
  readonly tree: (
    repository: AppCodeId,
    tree: string,
  ) => Effect.Effect<ReadonlyArray<ArtifactsTreeFile>, SourceError>;
  /**
   * Each blob's size, in order. In `bytes` mode also its bytes, while the running total of sizes
   * is at most `budget`; past it a blob is read for its size only and its bytes are null.
   */
  readonly blobs: (
    repository: AppCodeId,
    objects: ReadonlyArray<string>,
    mode: "sizes" | "bytes",
    budget: number,
  ) => Effect.Effect<ReadonlyArray<ArtifactsBlob>, SourceError>;
  /** One file of a commit by path, or null when the path names no file. */
  readonly file: (
    repository: AppCodeId,
    commit: string,
    path: string,
  ) => Effect.Effect<Uint8Array | null, SourceError>;
}

/** A tree entry at its full path: a file, or another kind of entry the source refuses. */
export interface ArtifactsTreeFile {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly object: string;
}

/** One blob's size, and its bytes when they fit the requested budget. */
export interface ArtifactsBlob {
  readonly object: string;
  readonly size: number;
  readonly bytes: Uint8Array | null;
}
