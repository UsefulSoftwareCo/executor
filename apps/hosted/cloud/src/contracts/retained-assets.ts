import { Schema } from "effect";

export const retainedAssetFolders = ["assets", "_astro", "docs/_astro"] as const;

export const retainedAssetPath =
  /^(?:assets|_astro|docs\/_astro)\/(?:fonts\/[0-9a-f]{16}|[^/]+[-.][\w-]{8})\.[a-z0-9]+$/;

export const retainedAssetCacheControl = "public, max-age=31536000, immutable";

export const retainedAssetList = "/retained-assets.json";

export const RetainedAssetList = Schema.Struct({
  build: Schema.String,
  files: Schema.Array(Schema.String),
});

export const retainedAssetExpiryDays = 35;

export const retainedAssetRefreshHours = 24;
