import { createHash } from "node:crypto";
import { Effect, FileSystem, Path } from "effect";

export const treeDigest = (
  directory: string,
  content: (relative: string, bytes: Uint8Array) => Uint8Array | undefined = (_, bytes) => bytes,
) =>
  treeFiles(directory, content).pipe(
    Effect.map((lines) => createHash("sha256").update(lines.join("\n")).digest("hex")),
  );

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
