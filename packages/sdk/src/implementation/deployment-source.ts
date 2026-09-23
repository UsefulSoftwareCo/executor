/** Immutable deployment inputs are retained independently of editable Git history. */
import { Effect, Option, Schema } from "effect";
import { BlobKey, type BlobStorage } from "../contracts/blobs.ts";
import { DeploymentId, StorageError } from "../contracts/shared.ts";
import { SourceFiles } from "../contracts/source.ts";

const key = (deployment: DeploymentId) => BlobKey.make(`deployments/${deployment}/source.json`);

/** Persist the complete input before publishing a deployment record. */
export const writeDeploymentSource = (
  blobs: BlobStorage,
  deployment: DeploymentId,
  files: SourceFiles,
) =>
  blobs
    .put(key(deployment), new TextEncoder().encode(JSON.stringify(files)))
    .pipe(Effect.mapError(() => new StorageError()));

/** Read and parse retained inputs; absent or damaged objects are storage failures. */
export const readDeploymentSource = (blobs: BlobStorage, deployment: DeploymentId) =>
  Effect.gen(function* () {
    const bytes = yield* blobs.get(key(deployment)).pipe(Effect.mapError(() => new StorageError()));
    if (Option.isNone(bytes)) return yield* new StorageError();
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SourceFiles))(
      new TextDecoder().decode(bytes.value),
    ).pipe(Effect.mapError(() => new StorageError()));
  });
