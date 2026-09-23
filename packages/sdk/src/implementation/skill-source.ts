/** Parse skill source without loading app code, resolving accounts, or reading host files. */
import { Effect, Schema } from "effect";
import { parseDocument } from "yaml";
import type { SourceFile, SourceFiles } from "../contracts/deployment.ts";
import {
  AppSkillMetadata,
  AppSkillName,
  SkillDefinitionInvalid,
  type AppSkillSource,
} from "../contracts/skill-source.ts";

const metadata = (file: SourceFile) =>
  Effect.gen(function* () {
    const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|[ \t]*$)/.exec(
      file.content,
    );
    if (match?.[1] === undefined)
      return yield* new SkillDefinitionInvalid({ file: file.path, reason: "frontmatter" });
    const source = match[1];
    const value: unknown = yield* Effect.try({
      try: () => {
        const document = parseDocument(source);
        if (document.errors.length > 0) throw document.errors[0];
        return document.toJS();
      },
      catch: () => new SkillDefinitionInvalid({ file: file.path, reason: "frontmatter" }),
    });
    return yield* Schema.decodeUnknownEffect(AppSkillMetadata)(value).pipe(
      Effect.mapError(() => new SkillDefinitionInvalid({ file: file.path, reason: "metadata" })),
    );
  });

/**
 * Validate skills/<name>/SKILL.md and collect its text resources from an immutable snapshot.
 * The reserved skills directory contains skill folders, each with a matching frontmatter name.
 * SourceFiles has already rejected traversal and duplicate paths at the deployment boundary.
 */
export const prepareAppSkills = (
  files: SourceFiles,
): Effect.Effect<readonly AppSkillSource[], SkillDefinitionInvalid> =>
  Effect.gen(function* () {
    const directories = new Map<string, SourceFile[]>();
    for (const file of files) {
      if (!file.path.startsWith("skills/")) continue;
      const [, name, ...path] = file.path.split("/");
      if (name === undefined || path.length === 0 || !Schema.is(AppSkillName)(name))
        return yield* new SkillDefinitionInvalid({ file: file.path, reason: "directory" });
      const existing = directories.get(name);
      if (existing === undefined) directories.set(name, [file]);
      else existing.push(file);
    }
    return yield* Effect.forEach(
      [...directories].sort(([left], [right]) => left.localeCompare(right)),
      ([name, sources]) =>
        Effect.gen(function* () {
          const prefix = `skills/${name}/`;
          const document = sources.find((file) => file.path === `${prefix}SKILL.md`);
          if (document === undefined)
            return yield* new SkillDefinitionInvalid({
              file: `${prefix}SKILL.md`,
              reason: "missing-document",
            });
          const info = yield* metadata(document);
          if (info.name !== name)
            return yield* new SkillDefinitionInvalid({
              file: document.path,
              reason: "name-mismatch",
            });
          return {
            ...info,
            files: sources
              .map((file) => ({ path: file.path.slice(prefix.length), content: file.content }))
              .sort((left, right) => left.path.localeCompare(right.path)),
          };
        }),
    );
  });
