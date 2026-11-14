/** One SHA-256 for the regular files of a directory tree, so two builds can be compared. */
import { createHash } from "node:crypto";
import { Effect, FileSystem, Path } from "effect";

/**
 * The SHA-256 of `directory`'s files: each file's path, relative to `directory` with `/`
 * separators, and the SHA-256 of its bytes, one line each in path order. Symbolic links are
 * followed: a link to a file counts as a file with the target's bytes at the link's path, so
 * whether a path is a link, and where it points, is not covered. File modes and empty
 * directories are not covered either. `content` may replace a file's bytes before they are
 * hashed, or leave the file out by returning undefined.
 */
export const treeDigest = (
  directory: string,
  content: (relative: string, bytes: Uint8Array) => Uint8Array | undefined = (_, bytes) => bytes,
) =>
  treeFiles(directory, content).pipe(
    Effect.map((lines) => createHash("sha256").update(lines.join("\n")).digest("hex")),
  );

/** The lines `treeDigest` hashes: each file's path and the SHA-256 of its bytes, in path order. */
export const treeFiles = (
  directory: string,
  content: (relative: string, bytes: Uint8Array) => Uint8Array | undefined = (_, bytes) => bytes,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lines: Array<string> = [];
    const relatives = (yield* fs.readDirectory(directory, { recursive: true }))
      .map((relative) => relative.split(path.sep).join("/"))
      .toSorted();
    for (const relative of relatives) {
      const file = path.join(directory, ...relative.split("/"));
      if ((yield* fs.stat(file)).type !== "File") continue;
      const bytes = content(relative, yield* fs.readFile(file));
      if (bytes === undefined) continue;
      lines.push(`${relative} ${createHash("sha256").update(bytes).digest("hex")}`);
    }
    return lines;
  });
