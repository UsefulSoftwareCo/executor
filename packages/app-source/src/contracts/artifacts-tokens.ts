/** Server-only Artifacts credentials. The host owns persistence and refresh coordination. */
import type { Effect, Redacted } from "effect";
import type { AppCodeId, SourceError } from "./repositories.ts";

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
}
