/**
 * The images, audio and files a tool result carries as MCP content blocks, written to disk for the
 * tool commands. The host moves each block's bytes out of the result's JSON and leaves the block
 * without them, plus its `contentIndex`, in its place. The CLI prints only that JSON, so it writes
 * each block's bytes to a file and adds the file's `path` beside the `contentIndex`.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect";

const Media = Schema.Struct({
  type: Schema.Literals(["image", "audio"]),
  mimeType: Schema.String,
  data: Schema.Uint8ArrayFromBase64,
});
const BlobResource = Schema.Struct({
  type: Schema.Literal("resource"),
  resource: Schema.Struct({
    uri: Schema.String,
    mimeType: Schema.optional(Schema.String),
    blob: Schema.Uint8ArrayFromBase64,
  }),
});
const decodeBlock = Schema.decodeUnknownOption(Schema.Union([Media, BlobResource]));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeComponent = Option.liftThrowable(decodeURIComponent);

/** `.pdf` for `application/pdf`, `.svg` for `image/svg+xml`; nothing for an unusual type. */
const extension = (mimeType: string | undefined) => {
  const subtype = mimeType?.split(";")[0]?.split("/")[1]?.split("+")[0]?.trim().toLowerCase();
  if (subtype === undefined || !/^[a-z0-9-]{1,16}$/u.test(subtype)) return "";
  return subtype === "jpeg" ? ".jpg" : `.${subtype}`;
};

/**
 * A safe file name for the block at `index`: the index, then the resource URI's last path segment
 * with anything but letters, digits, `.`, `_` and `-` replaced, or `content` and the extension its
 * MIME type implies.
 */
const fileName = (index: number, uri: string | undefined, mimeType: string | undefined) => {
  const segment = uri === undefined ? "" : (URL.parse(uri)?.pathname ?? uri).split("/").at(-1);
  const decoded = Option.getOrElse(decodeComponent(segment ?? ""), () => segment ?? "");
  const safe = decoded
    .replaceAll(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[.-]+/u, "")
    .slice(0, 100);
  const name = safe === "" ? "content" : safe;
  return `${index}-${name}${name.includes(".") ? "" : extension(mimeType)}`;
};

/**
 * Write each image, audio and blob resource block in `content` to its own file in `directory`, or
 * in a new temporary directory when none is given, and return `value` with each placeholder that
 * names one of those blocks by `contentIndex` given the file's `path`. A result without such
 * blocks is returned unchanged and writes nothing.
 */
export const saveContentFiles = (
  value: unknown,
  content: ReadonlyArray<unknown>,
  directory: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const blocks = content.flatMap((block, index) =>
      Option.toArray(decodeBlock(block)).map((decoded) => ({ index, decoded })),
    );
    if (blocks.length === 0) return value;
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const into = yield* Option.match(directory, {
      onNone: () => fs.makeTempDirectory({ prefix: "executor-files-" }),
      onSome: (directory) =>
        fs.makeDirectory(directory, { recursive: true }).pipe(Effect.as(path.resolve(directory))),
    });
    const paths = new Map<number, string>();
    for (const { index, decoded } of blocks) {
      const [uri, mimeType, bytes] =
        decoded.type === "resource"
          ? [decoded.resource.uri, decoded.resource.mimeType, decoded.resource.blob]
          : [undefined, decoded.mimeType, decoded.data];
      const file = path.join(into, fileName(index, uri, mimeType));
      yield* fs.writeFile(file, bytes);
      paths.set(index, file);
    }
    const annotate = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(annotate);
      if (!isRecord(value)) return value;
      const placeholder =
        (value.type === "image" || value.type === "audio" || value.type === "resource") &&
        typeof value.contentIndex === "number";
      const saved = placeholder ? paths.get(Number(value.contentIndex)) : undefined;
      if (saved !== undefined) return { ...value, path: saved };
      return Object.fromEntries(
        Object.entries(value).map(([key, field]) => [key, annotate(field)]),
      );
    };
    return annotate(value);
  });
