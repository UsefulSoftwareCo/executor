import { BlobKey, type BlobStorage } from "@executor-js/sdk/core";
import { Effect, Option, Schema, Stream } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import type { OrganizationId } from "../contracts/organization.ts";
import {
  OrganizationIcons,
  OrganizationIconInvalid,
  OrganizationIconNotFound,
  OrganizationIconUnavailable,
} from "../contracts/organization.ts";
import {
  OrganizationIconUrl,
  UploadedOrganizationIcon,
  organizationIconContentType,
} from "../contracts/organization-icon.ts";

/** Bound bytes before decoding, including when Content-Length is absent. */
export const readOrganizationIconUpload = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const limit = 3 * 1024 * 1024;
  const body = yield* request.stream.pipe(
    Stream.runFoldEffect(
      () => ({ bytes: new Uint8Array(limit), length: 0 }),
      (current, chunk) => {
        const length = current.length + chunk.length;
        if (length > limit) return Effect.fail(new OrganizationIconInvalid());
        current.bytes.set(chunk, current.length);
        return Effect.succeed({ bytes: current.bytes, length });
      },
    ),
  );
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(UploadedOrganizationIcon))(
    new TextDecoder().decode(body.bytes.subarray(0, body.length)),
  );
}).pipe(Effect.mapError(() => new OrganizationIconInvalid()));

/** Organization namespaces prevent references from another team from granting image access. */
export const makeOrganizationIcons = (blobs: BlobStorage) =>
  OrganizationIcons.of({
    upload: (organization, image) =>
      Effect.gen(function* () {
        const digest = yield* Effect.tryPromise(() =>
          crypto.subtle.digest("SHA-256", new Uint8Array(image.bytes).buffer),
        );
        const key = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const encoded = encodeURIComponent(organization);
        const logo = yield* Schema.decodeUnknownEffect(OrganizationIconUrl)(
          `/api/organizations/${encoded}/icons/${key}`,
        );
        yield* blobs.put(BlobKey.make(`organization-icons/org-${encoded}/${key}`), image.bytes);
        return { logo };
      }).pipe(Effect.mapError(() => new OrganizationIconUnavailable())),
    read: (organization, key) =>
      Effect.gen(function* () {
        const bytes = yield* blobs.get(
          BlobKey.make(`organization-icons/org-${encodeURIComponent(organization)}/${key}`),
        );
        if (Option.isNone(bytes)) return yield* new OrganizationIconNotFound();
        const contentType = organizationIconContentType(bytes.value);
        if (contentType === undefined) return yield* new OrganizationIconUnavailable();
        return { bytes: bytes.value, contentType };
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(OrganizationIconNotFound)(error) ? error : new OrganizationIconUnavailable(),
        ),
      ),
    remove: (organization, key) =>
      blobs
        .remove(BlobKey.make(`organization-icons/org-${encodeURIComponent(organization)}/${key}`))
        .pipe(Effect.mapError(() => new OrganizationIconUnavailable())),
  });

/** The saved logo is the only addressable icon; other values are external URLs. */
export const organizationIconKey = (organization: OrganizationId, logo: string | null) => {
  if (logo === null) return undefined;
  const prefix = `/api/organizations/${encodeURIComponent(organization)}/icons/`;
  return logo.startsWith(prefix) ? logo.slice(prefix.length) : undefined;
};
