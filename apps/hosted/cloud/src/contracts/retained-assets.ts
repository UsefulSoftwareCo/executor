/**
 * Browser files from earlier deploys stay reachable, so a page still running a replaced build can
 * load the files it has not loaded yet. Static assets serve only the current build; the Worker
 * copies these folders to R2 and answers an asset miss from there.
 *
 * Every file in these folders has a content-hashed name (Vite and Astro output), so a name never
 * changes meaning and an old copy is always the right bytes. Never add a folder with stable names.
 */
import { Schema } from "effect";

export const retainedAssetFolders = ["assets", "_astro", "docs/_astro"] as const;

/**
 * A retained file's path: one of the folders, then a name with Vite's and Astro's eight-character
 * hash (`Groups-B3dQx1aZ.js`, `Layout.Dokoevew.css`) or an Astro font file named by its hash. The
 * site build fails on any other name in those folders, and the Worker looks up nothing else in R2.
 */
export const retainedAssetPath =
  /^(?:assets|_astro|docs\/_astro)\/(?:fonts\/[0-9a-f]{16}|[^/]+[-.][\w-]{8})\.[a-z0-9]+$/;

/**
 * The `Cache-Control` of every retained file, from the static assets and from R2 alike. A name never
 * changes meaning, so a browser keeps its copy for a year and never revalidates it.
 */
export const retainedAssetCacheControl = "public, max-age=31536000, immutable";

/** The static asset the site build writes, listing the current build's retained files. */
export const retainedAssetList = "/retained-assets.json";

export const RetainedAssetList = Schema.Struct({
  /** Names the list: a hash of the sorted file paths. */
  build: Schema.String,
  /** Paths below the asset root without a leading slash, which are also the R2 keys. */
  files: Schema.Array(Schema.String),
});

/**
 * R2 deletes a copy this long after its last upload. The Worker uploads each current file again once
 * its copy is a day old, so a file a deploy replaces stays reachable for at least 30 days; the rest
 * of the margin covers a copy job that runs late.
 */
export const retainedAssetExpiryDays = 35;

/** The Worker copies a current file again once its stored copy is this old. */
export const retainedAssetRefreshHours = 24;
