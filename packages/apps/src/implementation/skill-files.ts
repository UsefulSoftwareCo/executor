/** One parser for packaged, GitHub and well-known skill files. */
import { Effect, Schema } from "effect";
import { parseDocument } from "yaml";
import {
  AppSkillMetadata,
  AppSkillName,
  AppSkillSource,
  SkillDefinitionInvalid,
  SkillFile,
  SkillFilePath,
  type FolderSkillsOptions,
} from "../contracts/skills.ts";

/** Parse one skill directory, retaining its full document and validating an optional source name. */
export const skillFromFiles = (
  input: readonly SkillFile[],
  source: { readonly directory?: string; readonly name?: string } = {},
): Effect.Effect<AppSkillSource, SkillDefinitionInvalid> =>
  Effect.gen(function* () {
    const file = `${source.directory === undefined ? "" : `${source.directory}/`}SKILL.md`;
    const invalid = (reason: SkillDefinitionInvalid["reason"]) =>
      new SkillDefinitionInvalid({ file, reason });
    const files = yield* Schema.decodeUnknownEffect(Schema.Array(SkillFile))(input).pipe(
      Effect.mapError(() => invalid("files")),
    );
    const document = files.find((file) => file.path === "SKILL.md");
    if (document === undefined) return yield* invalid("missing-document");
    const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|[ \t]*$)/.exec(
      document.content,
    );
    if (match?.[1] === undefined) return yield* invalid("frontmatter");
    const frontmatter = match[1];
    const value: unknown = yield* Effect.try({
      try: () => {
        const yaml = parseDocument(frontmatter);
        if (yaml.errors.length) throw yaml.errors[0];
        return yaml.toJS();
      },
      catch: () => invalid("frontmatter"),
    });
    const metadata = yield* Schema.decodeUnknownEffect(AppSkillMetadata)(value).pipe(
      Effect.mapError(() => invalid("metadata")),
    );
    if (source.name !== undefined && metadata.name !== source.name)
      return yield* invalid("name-mismatch");
    return yield* Schema.decodeUnknownEffect(AppSkillSource)({ ...metadata, files }).pipe(
      Effect.mapError(() => invalid("files")),
    );
  });

/** Select immediate skill directories from packaged text files. Never accesses the host filesystem. */
export const folderSkillsEffect = (
  options: FolderSkillsOptions,
): Effect.Effect<readonly AppSkillSource[], SkillDefinitionInvalid> =>
  Effect.gen(function* () {
    const path = options.path ?? "skills";
    if (!Schema.is(SkillFilePath)(path))
      return yield* new SkillDefinitionInvalid({ file: "SKILL.md", reason: "directory" });
    const files = yield* Schema.decodeUnknownEffect(Schema.Array(SkillFile))(options.files).pipe(
      Effect.mapError(() => new SkillDefinitionInvalid({ file: path, reason: "files" })),
    );
    const prefix = `${path}/`;
    const directories = new Map<string, SkillFile[]>();
    for (const file of files) {
      if (!file.path.startsWith(prefix)) continue;
      const [name, ...relative] = file.path.slice(prefix.length).split("/");
      if (name === undefined || relative.length === 0 || !Schema.is(AppSkillName)(name))
        return yield* new SkillDefinitionInvalid({ file: file.path, reason: "directory" });
      const resource = { path: relative.join("/"), content: file.content };
      const existing = directories.get(name);
      if (existing === undefined) directories.set(name, [resource]);
      else existing.push(resource);
    }
    return yield* Effect.forEach(
      [...directories].sort(([a], [b]) => a.localeCompare(b)),
      ([name, files]) =>
        skillFromFiles(
          files.sort((a, b) => a.path.localeCompare(b.path)),
          { name, directory: `${path}/${name}` },
        ),
    );
  });
