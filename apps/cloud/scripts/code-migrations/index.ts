import type { CodeMigration } from "./runner";
import { googleOpenApiR2BlobMigration } from "./google-openapi-r2-blobs";

export interface CloudCodeMigrationRegistryOptions {
  readonly r2Bucket?: string;
  readonly limit?: number;
}

export const cloudCodeMigrations = ({
  r2Bucket,
  limit,
}: CloudCodeMigrationRegistryOptions): readonly CodeMigration[] => [
  ...(r2Bucket ? [googleOpenApiR2BlobMigration({ bucket: r2Bucket, limit })] : []),
];

export { runCodeMigrations } from "./runner";
