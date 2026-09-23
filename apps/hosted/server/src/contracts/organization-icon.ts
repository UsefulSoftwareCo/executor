import { Schema } from "effect";

/** Team icons are small raster images, never active SVG or HTML documents. */
export const organizationIconMaxBytes = 2 * 1024 * 1024;
/** Media types accepted by the picker and served by the private image endpoint. */
export type OrganizationIconContentType = "image/png" | "image/jpeg" | "image/webp";
/** Identify a raster image from its bytes rather than the caller's filename or MIME header. */
export const organizationIconContentType = (
  bytes: Uint8Array,
): OrganizationIconContentType | undefined => {
  if (bytes.length < 12) return undefined;
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (
    [82, 73, 70, 70].every((value, index) => bytes[index] === value) &&
    [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)
  )
    return "image/webp";
  return undefined;
};
/** Base64 exists only on the JSON wire; consumers receive validated bytes. */
export const UploadedOrganizationIcon = Schema.Struct({
  bytes: Schema.String.check(Schema.isMaxLength(Math.ceil(organizationIconMaxBytes / 3) * 4)).pipe(
    Schema.decodeTo(Schema.Uint8ArrayFromBase64),
  ),
}).check(
  Schema.makeFilter(
    ({ bytes }) =>
      bytes.length <= organizationIconMaxBytes && organizationIconContentType(bytes) !== undefined,
  ),
);
export type UploadedOrganizationIcon = typeof UploadedOrganizationIcon.Type;
/** Opaque content digest within one uploader's namespace. */
export const OrganizationIconKey = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

/** Same-origin uploaded images use a canonical path, never a protocol-relative URL. */
export const OrganizationIconUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value, "https://executor.invalid");
      const matches = /^\/api\/organizations\/([^/?#]+)\/icons\/[a-f0-9]{64}$/.exec(value);
      return (
        url.origin === "https://executor.invalid" &&
        url.pathname === value &&
        matches !== null &&
        decodeURIComponent(matches[1] ?? "").length > 0
      );
    } catch {
      return false;
    }
  }),
);
