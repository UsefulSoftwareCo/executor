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

const extension = (mimeType: string | undefined) => {
  const subtype = mimeType?.split(";")[0]?.split("/")[1]?.split("+")[0]?.trim().toLowerCase();
  if (subtype === undefined || !/^[a-z0-9-]{1,16}$/u.test(subtype)) return "";
  return subtype === "jpeg" ? ".jpg" : `.${subtype}`;
};

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
