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
 * What the gallery draws for an artifact: sanitized markup of a real render,
 * either its create-time loading state or a settled one captured on open.
 */
const ArtifactPreviewResponse = Schema.Struct({
  kind: Schema.Literal("layout"),
  markup: Schema.String,
});

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
 * A snapshot of the artifact as the viewer just saw it, WITH its data.
 *
 * ## Data safety — read before widening who may call this
 *
 * Unlike the layout preview, this is captured after the artifact's queries
 * resolved, so it contains whatever the capturing viewer was allowed to see.
 * That makes it per-viewer state that happens to be stored on a shared-shaped
 * row.
 *
 * It is correct today only because of a property that holds by circumstance and
 * not by construction: artifacts are viewer-owned, so the only person who can
 * read the row is the person whose data is in the snapshot. When org-tier
 * sharing lands — the `owner` column already anticipates it — that stops being
 * true, and this preview would leak one member's numbers into another member's
 * gallery.
 *
 * At that point it must either move to per-viewer storage keyed by (artifact,
 * viewer), or be excluded from any view its capturer does not own. The LAYOUT
 * preview, written at create time from a render with no data in it, is the one
 * that stays shareable — which is why the column carries both kinds rather than
 * being replaced by this one.
 */
const SetArtifactPreviewPayload = Schema.Struct({
  /** Markup from the settled render. Sanitized by the handler through the same
   *  allowlist as the create-time preview before it is ever stored. */
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
