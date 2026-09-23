import { Effect, Encoding, Schema } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { BrowserAtoms } from "./telemetry.ts";
import {
  UploadedOrganizationIcon,
  organizationIconMaxBytes,
  organizationIconContentType,
} from "@executor-js/hosted-server/organization-icon";

/** One validated local file selection, before it is saved. */
export interface SelectedOrganizationIcon {
  readonly kind: "file";
  readonly logo: UploadedOrganizationIcon;
  readonly preview: string;
}

/** A local file could not be read or is not a supported, bounded image. */
export class OrganizationIconSelectionFailed extends Schema.TaggedError<OrganizationIconSelectionFailed>()(
  "OrganizationIconSelectionFailed",
  { message: Schema.String },
) {}
/** Read the selected file without uploading; the confirmation request owns persistence. */
export const selectOrganizationIconAtom = Atom.family((_userId: string) =>
  BrowserAtoms.fn((file: File) =>
    Effect.gen(function* () {
      if (file.size > organizationIconMaxBytes)
        return yield* new OrganizationIconSelectionFailed({
          message: "Choose an image smaller than 2 MB.",
        });
      const bytes = new Uint8Array(yield* Effect.tryPromise(() => file.arrayBuffer()));
      const contentType = organizationIconContentType(bytes);
      if (contentType === undefined)
        return yield* new OrganizationIconSelectionFailed({
          message: "Choose a PNG, JPEG, or WebP image.",
        });
      const logo = yield* Schema.decodeUnknownEffect(Schema.toType(UploadedOrganizationIcon))({
        bytes,
      });
      return {
        kind: "file" as const,
        logo,
        preview: `data:${contentType};base64,${Encoding.encodeBase64(bytes)}`,
      };
    }).pipe(
      Effect.mapError((error) =>
        error instanceof OrganizationIconSelectionFailed
          ? error
          : new OrganizationIconSelectionFailed({
              message: "This image could not be read. Choose another file.",
            }),
      ),
    ),
  ),
);
