import type { CodeMigration } from "./runner";
import { googleOpenApiR2BlobMigration } from "./google-openapi-r2-blobs";
import { gcDeadDcrOAuthClientsMigration } from "./gc-dead-dcr-oauth-clients";

export interface CloudCodeMigrationRegistryOptions {
  readonly r2Bucket?: string;
  readonly limit?: number;
}

export const cloudCodeMigrations = ({
  r2Bucket,
  limit,
}: CloudCodeMigrationRegistryOptions): readonly CodeMigration[] => [
  ...(r2Bucket ? [googleOpenApiR2BlobMigration({ bucket: r2Bucket, limit })] : []),
  // GC dead DCR oauth_client rows + backfill surviving rows' origin_issuer
  // (issue #1120, Part C). No R2/bucket dependency, so always registered.
  gcDeadDcrOAuthClientsMigration,
];

export { runCodeMigrations } from "./runner";
