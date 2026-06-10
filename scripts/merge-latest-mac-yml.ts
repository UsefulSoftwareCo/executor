#!/usr/bin/env bun
/**
 * Merge per-arch electron-builder update manifests into one latest-mac.yml.
 *
 * The desktop publish workflow builds mac arm64 and x64 in separate matrix
 * legs, and each electron-builder invocation emits its own latest-mac.yml
 * listing only that arch's artifacts. electron-updater clients fetch the
 * single `latest-mac.yml` from the release, so publishing either leg's file
 * as-is points every Mac at one arch (arm64 users were being served x64
 * zips). This script unions the `files` entries; electron-updater picks the
 * right one per client by matching the running arch against the file name.
 *
 * Usage: bun scripts/merge-latest-mac-yml.ts <x64.yml> <arm64.yml> <out.yml>
 * The first input's top-level path/sha512 (the legacy single-file fields read
 * by very old updaters) are kept, so pass the x64 manifest first.
 */

interface UpdateFileEntry {
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
}

interface UpdateManifest {
  readonly version: string;
  readonly files: readonly UpdateFileEntry[];
  readonly path: string;
  readonly sha512: string;
  readonly releaseDate: string;
}

const isUpdateFileEntry = (value: unknown): value is UpdateFileEntry => {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["url"] === "string" &&
    typeof entry["sha512"] === "string" &&
    typeof entry["size"] === "number"
  );
};

const parseManifest = (source: string, path: string): UpdateManifest => {
  const raw = Bun.YAML.parse(source) as Record<string, unknown>;
  const files = Array.isArray(raw["files"]) ? raw["files"].filter(isUpdateFileEntry) : [];
  if (
    typeof raw["version"] !== "string" ||
    typeof raw["path"] !== "string" ||
    typeof raw["sha512"] !== "string" ||
    typeof raw["releaseDate"] !== "string" ||
    files.length === 0
  ) {
    throw new Error(`Unrecognized electron-builder update manifest at ${path}`);
  }
  return {
    version: raw["version"],
    files,
    path: raw["path"],
    sha512: raw["sha512"],
    releaseDate: raw["releaseDate"],
  };
};

const serializeManifest = (manifest: UpdateManifest): string =>
  [
    `version: ${manifest.version}`,
    "files:",
    ...manifest.files.flatMap((file) => [
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`,
    ]),
    `path: ${manifest.path}`,
    `sha512: ${manifest.sha512}`,
    `releaseDate: '${manifest.releaseDate}'`,
    "",
  ].join("\n");

const [primaryPath, secondaryPath, outPath] = process.argv.slice(2);
if (!primaryPath || !secondaryPath || !outPath) {
  throw new Error("Usage: merge-latest-mac-yml.ts <primary.yml> <secondary.yml> <out.yml>");
}

const primary = parseManifest(await Bun.file(primaryPath).text(), primaryPath);
const secondary = parseManifest(await Bun.file(secondaryPath).text(), secondaryPath);

if (primary.version !== secondary.version) {
  throw new Error(
    `Refusing to merge mismatched versions: ${primary.version} (${primaryPath}) vs ${secondary.version} (${secondaryPath})`,
  );
}

const seen = new Set<string>();
const files = [...primary.files, ...secondary.files].filter((file) => {
  if (seen.has(file.url)) return false;
  seen.add(file.url);
  return true;
});

await Bun.write(outPath, serializeManifest({ ...primary, files }));
console.log(`Merged ${primaryPath} + ${secondaryPath} → ${outPath} (${files.length} files)`);
