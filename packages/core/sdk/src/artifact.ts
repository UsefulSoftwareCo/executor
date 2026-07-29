// ---------------------------------------------------------------------------
// Artifacts — saved generative-UI components. Row → public projection plus the
// operation inputs; the executor stitches these into `executor.artifacts` and
// the core `artifacts` HTTP group.
//
// An artifact IS the stored JSX source plus the title/description an agent
// matches against ("show me my active users dashboard"). Owner-scoped like a
// connection: created at the `user` tier, readable through the same owner
// policy, so org-tier sharing later needs no new machinery.
// ---------------------------------------------------------------------------

import { Option, Schema } from "effect";

import type { ArtifactRow, ArtifactSummaryRow } from "./core-schema";
import { ArtifactId, ConnectionName, IntegrationSlug, Owner } from "./ids";

/**
 * Which connection one integration role in the artifact's code resolves to.
 *
 * Artifact source names an integration and, when it needs two accounts of one,
 * a role — `tools.linear("prod").issues.list`. The three address segments that
 * were taken OUT of the source live here, so the host can put them back at
 * invoke time. Storing the tier and connection NAME (rather than a connection
 * row id) keeps this a pure address projection: it re-resolves against whoever
 * is viewing, which is what makes rebinding a shared artifact possible later.
 */
export const ArtifactBinding = Schema.Struct({
  integration: IntegrationSlug,
  owner: Owner,
  connection: ConnectionName,
}).annotate({
  description:
    "The connection one integration role in an artifact's code resolves to, as the three address segments the source omits.",
});
export type ArtifactBinding = typeof ArtifactBinding.Type;

/** `role -> connection` for every integration role the artifact's code uses. */
export const ArtifactBindings = Schema.Record(Schema.String, ArtifactBinding).annotate({
  description:
    "Every integration role an artifact's code uses, mapped to the connection it runs as.",
});
export type ArtifactBindings = typeof ArtifactBindings.Type;

const decodeBindings = Schema.decodeUnknownOption(ArtifactBindings);
const decodeJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

/**
 * The stored column, as bindings.
 *
 * JSON arrives as an object on Postgres and as a string on SQLite, and is
 * absent entirely on rows written before bindings existed. Absent is `null`,
 * which is meaningful: it is what marks an artifact as pre-contract and lets
 * its old five-segment paths run as written.
 *
 * A column that is present but undecodable is therefore NOT null — it becomes
 * an empty binding set, so every role in the artifact fails closed with
 * `binding_unresolved` instead of falling through the pre-contract door. Only
 * this host writes the column, so the case means corruption; failing visibly
 * on the artifact is the honest outcome.
 */
const bindingsFromColumn = (value: unknown): ArtifactBindings | null => {
  if (value === null || value === undefined) return null;
  const json = typeof value === "string" ? decodeJsonString(value) : Option.some(value);
  return Option.flatMap(json, decodeBindings).pipe(Option.getOrElse(() => ({})));
};

/**
 * What the gallery draws for an artifact, when it has anything to draw.
 *
 * Two kinds, in quality order:
 *
 *   - `layout` — sanitized markup from the create-time smoke render. The
 *     artifact's real composition in its LOADING state, so it contains no live
 *     data and is derived purely from the source. Written on every save.
 *   - `image` — a raster snapshot captured after a viewer opened the artifact
 *     and it settled with real data. Strictly better to look at, and strictly
 *     more sensitive: see the sharing note on `ArtifactPreview`.
 *
 * Stored in one column and discriminated by shape rather than by a second
 * column: an image is always a `data:image/` URL and markup never can be, so
 * the shape is already a total discriminator and a `preview_kind` column could
 * only ever disagree with it.
 */
export type ArtifactPreview =
  | { readonly kind: "layout"; readonly markup: string }
  | { readonly kind: "image"; readonly src: string };

/** The prefix an image preview always has, and markup never does. */
const IMAGE_PREVIEW_PREFIX = "data:image/";

/**
 * Read the stored column as a preview.
 *
 * Absent, empty, or anything that is not a string is `null` — the caller falls
 * back to the schematic. A `data:image/` value is an image; everything else is
 * markup, which is safe to assume because only this host writes the column and
 * only ever after sanitizing.
 */
export const previewFromColumn = (value: unknown): ArtifactPreview | null => {
  if (typeof value !== "string" || value === "") return null;
  return value.startsWith(IMAGE_PREVIEW_PREFIX)
    ? { kind: "image", src: value }
    : { kind: "layout", markup: value };
};

/** Whether a stored preview value is a raster snapshot rather than markup. */
export const isImagePreviewValue = (value: string): boolean =>
  value.startsWith(IMAGE_PREVIEW_PREFIX);

export interface Artifact {
  readonly id: ArtifactId;
  readonly owner: Owner;
  readonly title: string;
  /** Model-supplied prose used for agent matching. Null when none was given. */
  readonly description: string | null;
  /** The JSX source. Only the full read carries it — lists stay light. */
  readonly code: string;
  /**
   * Which connection each integration role in `code` runs as.
   *
   * `null` means the artifact predates the binding contract: its source still
   * carries full `tools.<integration>.<tier>.<connection>.<tool>` addresses and
   * executes them as written. Every artifact saved since is bound, even if the
   * binding set is empty (code that calls no integration).
   */
  readonly bindings: ArtifactBindings | null;
  /**
   * What the gallery draws for this artifact, or `null` to fall back to the
   * schematic.
   *
   * DATA SAFETY. A `layout` preview is derived from `code` alone and is safe to
   * treat as shared artifact metadata. An `image` preview is NOT: it is pixels
   * of the artifact rendered with whatever data the VIEWER could see. Today
   * every artifact is viewer-owned, so the row and the viewer are the same
   * person and storing it here is correct. When org-tier sharing lands, an
   * image preview must move to per-viewer storage or be excluded from shared
   * views — otherwise one member's numbers become another's thumbnail. The
   * `layout` half stays shareable either way, which is why both kinds exist.
   */
  readonly preview: ArtifactPreview | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What a list returns: everything except the source and the bindings that
 *  interpret it. Both are only meaningful to a renderer, and both are heavy.
 *  The preview stays, because the list is what draws it. */
export type ArtifactSummary = Omit<Artifact, "code" | "bindings">;

/** Create a new artifact, or overwrite an existing one in place when `id` names
 *  one. v1 has no version history: a save replaces the stored source. */
export interface SaveArtifactInput {
  readonly id?: string;
  readonly title: string;
  readonly description?: string | null;
  readonly code: string;
  /**
   * The connections `code`'s integration roles resolve to. Written on every
   * save, since code and bindings are one fact: replacing the source without
   * its bindings would leave the artifact interpreting new roles through old
   * connections.
   */
  readonly bindings?: ArtifactBindings | null;
  /**
   * The layout preview for this source, already sanitized.
   *
   * Written on every save for the same reason as `bindings`: it is an
   * interpretation of `code`, so carrying the old one forward under new source
   * would show the gallery an artifact that no longer exists. Omitted or
   * `null` clears it — including when a save supersedes an image preview,
   * which is correct, since that image is of the previous version.
   */
  readonly preview?: string | null;
}

export interface RenameArtifactInput {
  readonly id: string;
  readonly title: string;
}

export interface RemoveArtifactInput {
  readonly id: string;
}

/**
 * Upgrade an artifact's preview to a raster snapshot of a settled render.
 *
 * Separate from `SaveArtifactInput` because it is a different act by a
 * different party: a save is the MODEL replacing the source, this is a VIEWER
 * reporting what the artifact actually looked like. It touches no other column
 * and deliberately does not move `updated_at` — being looked at is not an edit,
 * and the gallery sorts by that timestamp.
 */
export interface SetArtifactPreviewInput {
  readonly id: string;
  /** A `data:image/...` URL. Rejected by the handler if it is anything else. */
  readonly preview: string;
}

const asDate = (value: Date | number | string): Date =>
  value instanceof Date ? value : new Date(value);

export const rowToArtifactSummary = (row: ArtifactSummaryRow): ArtifactSummary => ({
  id: ArtifactId.make(row.id),
  owner: row.owner as Owner,
  title: row.title,
  description: row.description ?? null,
  preview: previewFromColumn(row.preview),
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at),
});

export const rowToArtifact = (row: ArtifactRow): Artifact => ({
  ...rowToArtifactSummary(row),
  code: row.code,
  bindings: bindingsFromColumn(row.bindings),
});
