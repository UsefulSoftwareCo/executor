import type { Effect } from "effect";
import { Data } from "effect";

// ---------------------------------------------------------------------------
// ArtifactStore — the per-scope git-backed source store.
//
// A scope's source lives as a bare git repository; a publish writes a commit
// and the commit hash IS the snapshot id (immutable, content-addressed by git).
// The self-hosted backing is a bare git repo per scope on disk (git CLI via
// subprocess). The cloud backing (future) is Cloudflare Artifacts. The seam is
// substrate-neutral: read/write/list/latest/log over a flat file set, plus a
// snapshot immutability guarantee (a committed snapshot's bytes never change).
// ---------------------------------------------------------------------------

/** A published snapshot id. In the git backing this is the commit hash. */
export type SnapshotId = string & { readonly __snapshotId: unique symbol };

export const asSnapshotId = (value: string): SnapshotId => value as SnapshotId;

/** A flat set of source files, path -> UTF-8 contents. Paths are POSIX,
 *  relative to the scope root (e.g. `tools/issues-sync.ts`). */
export type FileSet = ReadonlyMap<string, string>;

export interface SnapshotMeta {
  readonly id: SnapshotId;
  readonly message: string;
  /** Epoch ms the snapshot was written. */
  readonly committedAt: number;
}

export class ArtifactStoreError extends Data.TaggedError("ArtifactStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * One scope's source store. `commit` writes a new snapshot from a full file set
 * and returns its id. `read` materializes a snapshot back to a file set.
 * `latest` is the most recent snapshot on the default branch (null when the
 * scope has never published). `log` lists snapshots newest-first.
 */
export interface ScopeArtifactStore {
  readonly commit: (
    files: FileSet,
    message: string,
  ) => Effect.Effect<SnapshotMeta, ArtifactStoreError>;
  readonly read: (id: SnapshotId) => Effect.Effect<FileSet, ArtifactStoreError>;
  readonly readFile: (
    id: SnapshotId,
    path: string,
  ) => Effect.Effect<string | null, ArtifactStoreError>;
  readonly list: (id: SnapshotId) => Effect.Effect<readonly string[], ArtifactStoreError>;
  readonly latest: () => Effect.Effect<SnapshotMeta | null, ArtifactStoreError>;
  readonly log: (limit?: number) => Effect.Effect<readonly SnapshotMeta[], ArtifactStoreError>;
}

/** The substrate-neutral store: hands out a per-scope store by scope key. */
export interface ArtifactStore {
  readonly forScope: (scope: string) => Effect.Effect<ScopeArtifactStore, ArtifactStoreError>;
}
