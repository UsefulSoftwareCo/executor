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

/**
 * What the gallery draws for an artifact.
 *
 * `layout` is sanitized markup from the create-time smoke render — the
 * artifact's real composition with no data in it. `image` is a raster snapshot
 * of a settled render, which DOES contain whatever the viewer could see.
 */
const ArtifactPreviewResponse = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("layout"), markup: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("image"), src: Schema.String }),
]);

/** What a list returns — no `code`, so a long list stays cheap. The preview is
 *  the exception, because the list is the surface that draws it. */
const ArtifactSummaryResponse = Schema.Struct({
  id: ArtifactId,
  owner: Owner,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  preview: Schema.NullOr(ArtifactPreviewResponse),
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

/**
 * The cap on an uploaded preview image, in characters of data URL.
 *
 * A 320x200 PNG of a dashboard is tens of kilobytes; base64 costs a third on
 * top. 512 KiB is generous for that and small enough that the column stays
 * cheap to project into every list.
 */
export const ARTIFACT_PREVIEW_IMAGE_LIMIT = 512 * 1024;

/**
 * A raster snapshot of the artifact as the viewer just saw it.
 *
 * ## Data safety — read before widening who may call this
 *
 * Unlike the layout preview, this image is rendered WITH DATA. It is pixels of
 * whatever the capturing viewer was allowed to see, which makes it per-viewer
 * state that happens to be stored on a shared-shaped row.
 *
 * That is correct only because of a property that holds TODAY and not by
 * construction: artifacts are viewer-owned, so the only person who can read the
 * row is the person whose data is in the picture. When org-tier sharing lands —
 * the `owner` column already anticipates it — this stops being true, and an
 * image preview would leak one member's numbers into another member's gallery.
 *
 * At that point this preview must either move to per-viewer storage keyed by
 * (artifact, viewer), or be excluded from any view the owner did not capture.
 * The layout preview is the one that stays shareable, which is why the column
 * carries both kinds rather than being replaced by this one.
 */
const SetArtifactPreviewPayload = Schema.Struct({
  /** A `data:image/...` URL. Anything else is rejected: the endpoint stores
   *  images, and the layout half is written by the save path only. */
  preview: Schema.String.check(Schema.isMaxLength(ARTIFACT_PREVIEW_IMAGE_LIMIT)),
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
  )
  .add(
    // Owner-scoped like every other endpoint here: the handler resolves the
    // artifact through the same owner policy, so a viewer can only ever upgrade
    // the preview of an artifact they can already read.
    HttpApiEndpoint.put("setPreview", "/artifacts/:artifactId/preview", {
      params: ArtifactParams,
      payload: SetArtifactPreviewPayload,
      success: Schema.Struct({ stored: Schema.Boolean }),
      error: [InternalError, ArtifactNotFound],
    }),
  );
