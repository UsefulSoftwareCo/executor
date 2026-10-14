/**
 * A deployment's public files: the `ui/public/` files of its source, copied by the deploy into the
 * host's blob store and served from there. Nothing outside the host reads or writes this store;
 * its objects belong to one app code lineage and are referenced by that lineage's deployments.
 */
import { Schema } from "effect";
import { BlobKey } from "./blobs.ts";
import type { AppCodeId } from "./shared.ts";
import { GitObjectId, SourceFilePath } from "./source.ts";

/**
 * Where a public file is served, relative to the page's origin. `index.html` is the app's page and
 * `_executor/` belongs to the host, so neither can be a public file.
 */
export const PublicFilePath = SourceFilePath.pipe(
  Schema.check(
    Schema.makeFilter((path: string) =>
      path === "index.html" || path === "_executor" || path.startsWith("_executor/")
        ? "expected a path other than index.html and _executor/"
        : true,
    ),
  ),
);

/** One served file: where, which blob, how large and with which content type. */
export const PublicFile = Schema.Struct({
  path: PublicFilePath,
  object: GitObjectId,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  contentType: Schema.NonEmptyString,
});
export type PublicFile = typeof PublicFile.Type;

/**
 * A build's public files, retained beside it at `<build>/public.json`. `code` names the lineage
 * whose store holds the bytes, so activating any retained deployment serves its own files.
 */
export const PublicFileManifest = Schema.Struct({
  code: Schema.String,
  files: Schema.Array(PublicFile),
});
export type PublicFileManifest = typeof PublicFileManifest.Type;

/** The store folder holding one code lineage's public files, named by their Git blob. */
export const publicFileFolder = (code: AppCodeId) => BlobKey.make(`app-public/${code}`);
export const publicFileKey = (code: AppCodeId | string, object: GitObjectId) =>
  BlobKey.make(`app-public/${code}/${object}`);

const contentTypes: Readonly<Record<string, string>> = {
  html: "text/html",
  htm: "text/html",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  wasm: "application/wasm",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
};

/**
 * The content type a file is served with, from its extension. Unknown files are plain bytes, and
 * `nosniff` keeps browsers from guessing another type.
 */
export const publicFileContentType = (path: string, fallback = "application/octet-stream") => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (dot <= 0 ? undefined : contentTypes[name.slice(dot + 1).toLowerCase()]) ?? fallback;
};
