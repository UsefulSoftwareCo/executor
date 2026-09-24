import { Effect, Encoding, Result } from "effect";

import type { BlobStore } from "./blob";
import { StorageError } from "./fuma-runtime";
import type { SkillPackageManifestFile, PreparedSkillRevision } from "./skill-package";

const namespaceFor = (ownerPartition: string): string => `${ownerPartition}/skills`;

const digestBytes = (bytes: Uint8Array): Effect.Effect<string> =>
  Effect.promise(async () => {
    const input = new Uint8Array(bytes.byteLength);
    input.set(bytes);
    const digest = await crypto.subtle.digest("SHA-256", input.buffer);
    return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
  });

export interface SkillPackageRepository {
  readonly put: (
    ownerPartition: string,
    revision: PreparedSkillRevision,
  ) => Effect.Effect<void, StorageError>;
  readonly read: (
    ownerPartition: string,
    file: SkillPackageManifestFile,
  ) => Effect.Effect<Uint8Array, StorageError>;
  readonly copy: (
    sourcePartition: string,
    destinationPartition: string,
    files: readonly SkillPackageManifestFile[],
  ) => Effect.Effect<void, StorageError>;
}

export const makeSkillPackageRepository = (store: BlobStore): SkillPackageRepository => ({
  put: (ownerPartition, revision) =>
    Effect.forEach(
      revision.files,
      (file) => store.put(namespaceFor(ownerPartition), file.digest, file.encodedBytes),
      { concurrency: 8, discard: true },
    ),
  read: (ownerPartition, file) =>
    Effect.gen(function* () {
      const encoded = yield* store.get(namespaceFor(ownerPartition), file.digest);
      if (encoded === null) {
        return yield* new StorageError({
          message: `Managed skill blob is missing for ${file.path}.`,
          cause: undefined,
        });
      }
      const decoded = Encoding.decodeBase64(encoded);
      if (Result.isFailure(decoded)) {
        return yield* new StorageError({
          message: `Managed skill blob is not valid base64 for ${file.path}.`,
          cause: decoded.failure,
        });
      }
      if (decoded.success.byteLength !== file.size) {
        return yield* new StorageError({
          message: `Managed skill blob size does not match for ${file.path}.`,
          cause: undefined,
        });
      }
      const digest = yield* digestBytes(decoded.success);
      if (digest !== file.digest) {
        return yield* new StorageError({
          message: `Managed skill blob digest does not match for ${file.path}.`,
          cause: undefined,
        });
      }
      return decoded.success;
    }),
  copy: (sourcePartition, destinationPartition, files) =>
    Effect.forEach(
      files,
      (file) =>
        Effect.gen(function* () {
          const bytes = yield* store.get(namespaceFor(sourcePartition), file.digest);
          if (bytes === null) {
            return yield* new StorageError({
              message: `Managed skill blob is missing for ${file.path}.`,
              cause: undefined,
            });
          }
          yield* store.put(namespaceFor(destinationPartition), file.digest, bytes);
        }),
      { concurrency: 8, discard: true },
    ),
});
