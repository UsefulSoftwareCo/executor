/**
 * Credential placement: where an auth method's secret fields may be sent. A placement is a
 * location in the request, a header or a query parameter, and a value template built from
 * literal text, references to the method's own account fields, and base64 of those. Executor's
 * outbound network substitutes a placed credential handle only where a request matches one of
 * its method's placements exactly, and refuses the request when the handle is anywhere else.
 */
import { Result, Schema } from "effect";
import { Base64 } from "effect/encoding";

/** A reference to one of the method's own account fields. */
export const PlacementField = Schema.Struct({ field: Schema.NonEmptyString });
export type PlacementField = typeof PlacementField.Type;

/** Literal text or a field reference: what base64 may encode. Base64 never nests. */
export const PlacementText = Schema.Union([Schema.String, PlacementField]);
export type PlacementText = typeof PlacementText.Type;

/** Base64 (RFC 4648, padded) of the UTF-8 bytes of its parts, such as Basic credentials. */
export const PlacementBase64 = Schema.Struct({
  base64: Schema.Array(PlacementText).check(Schema.isMinLength(1)),
});
export type PlacementBase64 = typeof PlacementBase64.Type;

/** One part of a value template. Parts concatenate. */
export const PlacementPart = Schema.Union([Schema.String, PlacementField, PlacementBase64]);
export type PlacementPart = typeof PlacementPart.Type;

const template = Schema.Array(PlacementPart).check(Schema.isMinLength(1));

/** A lowercase HTTP header name (RFC 9110 token). */
export const PlacementHeaderName = Schema.String.check(
  Schema.isPattern(/^[!#$%&'*+.^_`|~0-9a-z-]+$/u),
);

/**
 * Where a credential may be sent and the exact value it is sent as. A header placement is the
 * header's whole value; a query placement is the whole value of the named query parameter.
 */
export const Placement = Schema.Union([
  Schema.Struct({ in: Schema.Literal("header"), name: PlacementHeaderName, value: template }),
  Schema.Struct({ in: Schema.Literal("query"), name: Schema.NonEmptyString, value: template }),
]);
export type Placement = typeof Placement.Type;

/** An auth method's placements. */
export const Placements = Schema.Array(Placement);

/** Whether a part references a field. */
export const isPlacementField = (part: PlacementPart): part is PlacementField =>
  typeof part === "object" && "field" in part;

/** The field names a template references, base64 parts included. */
export const placementFields = (placement: Placement): ReadonlySet<string> =>
  new Set(
    placement.value.flatMap((part) =>
      typeof part === "string"
        ? []
        : isPlacementField(part)
          ? [part.field]
          : part.base64.flatMap((text) => (typeof text === "string" ? [] : [text.field])),
    ),
  );

const canonical = Schema.encodeSync(Schema.fromJsonString(Placement));

/** Placements are equal when their JSON is: same location, name and template. */
export const placementKey = (placement: Placement) => canonical(placement);

/** Placements in a stable order without repeats, so their order never changes an identity. */
export const normalizePlacements = (placements: readonly Placement[]): readonly Placement[] =>
  [...new Map(placements.map((placement) => [placementKey(placement), placement])).entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, placement]) => placement);

/** A field the template references has no string value. */
export class PlacementFieldMissing extends Schema.TaggedError<PlacementFieldMissing>()(
  "PlacementFieldMissing",
  { field: Schema.String },
) {
  override get message() {
    return `The credential placement references the account field "${this.field}", which has no string value.`;
  }
}

/** Render a template with field values. A referenced field without a string value fails. */
export const renderPlacement = (
  placement: Placement,
  fields: Readonly<Record<string, unknown>>,
): Result.Result<string, PlacementFieldMissing> => {
  const text = (parts: readonly PlacementText[]) => {
    let rendered = "";
    for (const part of parts) {
      if (typeof part === "string") {
        rendered += part;
        continue;
      }
      const value = Object.hasOwn(fields, part.field) ? fields[part.field] : undefined;
      if (typeof value !== "string")
        return Result.fail(new PlacementFieldMissing({ field: part.field }));
      rendered += value;
    }
    return Result.succeed(rendered);
  };
  let rendered = "";
  for (const part of placement.value) {
    const value =
      typeof part === "string" || isPlacementField(part)
        ? text([part])
        : Result.map(text(part.base64), (inner) => Base64.encode(inner));
    if (Result.isFailure(value)) return value;
    rendered += value.success;
  }
  return Result.succeed(rendered);
};
