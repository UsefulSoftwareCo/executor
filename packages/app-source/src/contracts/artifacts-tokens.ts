import type { Effect, Redacted } from "effect";
import type { AppCodeId, GitCommit, SourceError } from "@executor-js/sdk/core";

export interface ArtifactsToken {
  readonly generation: string;
  readonly token: Redacted.Redacted<string>;
}

export interface ArtifactsTokens {
  readonly create: (
    repository: AppCodeId,
  ) => Effect.Effect<Redacted.Redacted<string> | null, SourceError>;
  readonly acquire: (
    repository: AppCodeId,
    rejectedGeneration: string | null,
  ) => Effect.Effect<ArtifactsToken, SourceError>;
  readonly history: (
    repository: AppCodeId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<GitCommit>, SourceError>;
  readonly resolve: (
    repository: AppCodeId,
    ref: string,
  ) => Effect.Effect<{ readonly commit: string; readonly tree: string } | null, SourceError>;
  readonly tree: (
    repository: AppCodeId,
    tree: string,
  ) => Effect.Effect<ReadonlyArray<ArtifactsTreeFile>, SourceError>;
  readonly blobs: (
    repository: AppCodeId,
    objects: ReadonlyArray<string>,
    mode: "sizes" | "bytes",
    budget: number,
  ) => Effect.Effect<ReadonlyArray<ArtifactsBlob>, SourceError>;
  readonly file: (
    repository: AppCodeId,
    commit: string,
    path: string,
  ) => Effect.Effect<Uint8Array | null, SourceError>;
}

export interface ArtifactsTreeFile {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly object: string;
}

export interface ArtifactsBlob {
  readonly object: string;
  readonly size: number;
  readonly bytes: Uint8Array | null;
}
