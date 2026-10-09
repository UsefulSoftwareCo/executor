/** What a Worker uploads, attributed to source files, so a size change names what grew. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { resolve } from "node:path";

/** One Worker's upload: the bytes the budget counts, split by the source file each byte maps to. */
export interface WorkerUpload {
  readonly worker: string;
  readonly bytes: number;
  readonly budget: number;
  /** Uploaded bytes per source, keyed by its path from the repository root. */
  readonly sources: Readonly<Record<string, number>>;
}

/** Where each build writes its {@link WorkerUpload}, one JSON file per Worker. */
export const workerUploadDirectory = new URL("../../.generated/worker-uploads/", import.meta.url);

const repositoryRoot = new URL("../../../../../", import.meta.url);

const base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decode one source-map segment into its relative fields. */
const decodeSegment = (segment: string) => {
  const fields: Array<number> = [];
  let value = 0;
  let shift = 0;
  for (const character of segment) {
    const digit = base64.indexOf(character);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return fields;
};

/**
 * Attribute every byte of minified chunk code to the source its mapping segment points at. Bytes
 * with no source, such as generated text modules and newlines, count as the chunk's `unmapped`.
 */
export const attributeChunk = (
  code: string,
  map: { readonly mappings: string; readonly sources: ReadonlyArray<string> },
  sources: Map<string, number>,
  sourcePath: (source: string) => string,
  unmapped: string,
) => {
  const add = (source: string, bytes: number) =>
    sources.set(source, (sources.get(source) ?? 0) + bytes);
  const lines = code.split("\n");
  const mappedLines = map.mappings.split(";");
  let sourceIndex = 0;
  for (const [index, line] of lines.entries()) {
    if (index > 0) add(unmapped, 1);
    let column = 0;
    let previousColumn = 0;
    let previousSource = unmapped;
    for (const segment of (mappedLines[index] ?? "").split(",")) {
      if (segment === "") continue;
      const fields = decodeSegment(segment);
      column += fields[0] ?? 0;
      add(previousSource, Buffer.byteLength(line.slice(previousColumn, column)));
      if (fields.length >= 4) {
        sourceIndex += fields[1] ?? 0;
        previousSource = sourcePath(map.sources[sourceIndex] ?? unmapped);
      } else previousSource = unmapped;
      previousColumn = column;
    }
    add(previousSource, Buffer.byteLength(line.slice(previousColumn)));
  }
};

/** Name a source by its path from the repository root, or keep a virtual module's own id. */
export const sourcePathFrom = (chunkDirectory: string) => (source: string) => {
  if (!source.startsWith(".") && !source.startsWith("/")) return source;
  const absolute = resolve(chunkDirectory, source);
  const root = repositoryRoot.pathname;
  return absolute.startsWith(root) ? absolute.slice(root.length) : absolute;
};

/** The npm package or workspace package a source belongs to. */
export const packageOf = (source: string) => {
  if (source.startsWith("(")) return source;
  const installed = source.lastIndexOf("node_modules/");
  if (installed !== -1) {
    const [scope, name] = source.slice(installed + "node_modules/".length).split("/");
    return scope?.startsWith("@") ? `${scope}/${name}` : (scope ?? source);
  }
  const segments = source.split("/");
  if (segments[0] === "apps" && segments[1] === "hosted")
    return segments.slice(0, segments[3] === "web" ? 4 : 3).join("/");
  if (segments[0] === "apps" || segments[0] === "packages") return segments.slice(0, 2).join("/");
  return source;
};

/** Sum a Worker's sources by {@link packageOf}, largest first. */
export const packageBytes = (sources: Readonly<Record<string, number>>) => {
  const packages = new Map<string, number>();
  for (const [source, bytes] of Object.entries(sources))
    packages.set(packageOf(source), (packages.get(packageOf(source)) ?? 0) + bytes);
  return [...packages].toSorted((a, b) => b[1] - a[1]);
};

/** Write one Worker's upload for CI to read; the deploy writes it too, beside the bundle. */
export const writeWorkerUpload = (upload: WorkerUpload) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* path.fromFileUrl(workerUploadDirectory);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, `${upload.worker}.json`),
        `${JSON.stringify(upload, null, 2)}\n`,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
