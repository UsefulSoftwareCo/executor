// ---------------------------------------------------------------------------
// Artifacts HTTP API — saved generative-UI components.
//
// An artifact is the JSX source a model produced plus the title/description an
// agent matches against. Owner-scoped: every endpoint reads and writes only
// what the bound owner scope may see, so no owner travels on the wire.
// ---------------------------------------------------------------------------

import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  ArtifactBindings,
  ArtifactId,
  ArtifactNotFoundError,
  InternalError,
  Owner,
} from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const ArtifactParams = { artifactId: ArtifactId };

// ---------------------------------------------------------------------------
// Response / payload schemas
// ---------------------------------------------------------------------------

/** What a list returns — no `code`, so a long list stays cheap. */
const ArtifactSummaryResponse = Schema.Struct({
  id: ArtifactId,
  owner: Owner,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

const ArtifactResponse = Schema.Struct({
  ...ArtifactSummaryResponse.fields,
  code: Schema.String,
  /** Null for artifacts saved before the binding contract, whose code still
   *  carries full connection addresses. */
  bindings: Schema.NullOr(ArtifactBindings),
});

/** Omit `id` to create; pass one to overwrite that artifact in place. */
const SaveArtifactPayload = Schema.Struct({
  id: Schema.optional(ArtifactId),
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  code: Schema.String,
  bindings: Schema.optional(Schema.NullOr(ArtifactBindings)),
});

const RenameArtifactPayload = Schema.Struct({
  title: Schema.String,
});

// ---------------------------------------------------------------------------
// Error schemas with HTTP status annotations
// ---------------------------------------------------------------------------

const ArtifactNotFound = ArtifactNotFoundError.annotate({ httpApiStatus: 404 });

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const ArtifactsApi = HttpApiGroup.make("artifacts")
  .add(
    HttpApiEndpoint.get("list", "/artifacts", {
      success: Schema.Array(ArtifactSummaryResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/artifacts/:artifactId", {
      params: ArtifactParams,
      success: ArtifactResponse,
      error: [InternalError, ArtifactNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("save", "/artifacts", {
      payload: SaveArtifactPayload,
      success: ArtifactResponse,
      error: [InternalError, ArtifactNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.patch("rename", "/artifacts/:artifactId", {
      params: ArtifactParams,
      payload: RenameArtifactPayload,
      success: ArtifactResponse,
      error: [InternalError, ArtifactNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/artifacts/:artifactId", {
      params: ArtifactParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: InternalError,
    }),
  );
