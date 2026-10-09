/** Static source assets shared by ordinary local and hosted Executor apps. */
import { SourceFile } from "@executor-js/sdk/core";
import { Effect, FileSystem, Path } from "effect";
import { TemplateError } from "../contracts/templates.ts";

/** Skill files and the framework reference the management API serves. */
export const executorSkillFiles = (
  assets: Readonly<Record<string, string>>,
): readonly SourceFile[] =>
  Object.entries(assets).map(([path, content]) => SourceFile.make({ path, content }));

/**
 * Every skill directory under `executor/skills`, as `skills/<name>/<file>.md` paths. The `executor`
 * skill is the entry point every agent reads, so it locates the directory; each sibling is a skill.
 */
export const readExecutorSkillDocuments = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.dirname(
    path.dirname(
      yield* path.fromFileUrl(
        new URL(
          import.meta.resolve("@executor-js/app-templates/executor/skills/executor/SKILL.md"),
        ),
      ),
    ),
  );
  const skills = yield* Effect.filter(yield* fs.readDirectory(root), (name) =>
    fs.stat(path.join(root, name)).pipe(Effect.map((info) => info.type === "Directory")),
  );
  const files = yield* Effect.forEach(skills, (skill) =>
    Effect.gen(function* () {
      const directory = path.join(root, skill);
      return yield* Effect.forEach(
        (yield* fs.readDirectory(directory)).filter((name) => name.endsWith(".md")),
        (name) =>
          fs
            .readFileString(path.join(directory, name))
            .pipe(Effect.map((content) => [`skills/${skill}/${name}`, content] as const)),
      );
    }),
  );
  return files.flat();
});

/** Node hosts read the same package assets that Workers embed at build time. */
export const readExecutorSkills = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const documents = yield* readExecutorSkillDocuments;
  const reference = yield* fs.readFileString(
    yield* path.fromFileUrl(new URL(import.meta.resolve("apps/framework-reference.json"))),
  );
  return executorSkillFiles({
    ...Object.fromEntries(documents),
    "framework-reference.json": reference,
  });
}).pipe(
  Effect.mapError(
    () =>
      new TemplateError({
        code: "authoring_reference",
        reason: "Build apps before loading the Executor authoring reference.",
      }),
  ),
);
