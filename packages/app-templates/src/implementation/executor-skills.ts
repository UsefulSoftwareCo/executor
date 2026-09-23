/** Static source assets shared by ordinary local and hosted Executor apps. */
import { SourceFile } from "@executor-js/sdk/core";
import { Effect, FileSystem, Path } from "effect";
import { TemplateError } from "../contracts/templates.ts";

/** Include all topic references and generated framework documentation in the deployed source. */
export const executorSkillFiles = (
  assets: Readonly<Record<string, string>>,
): readonly SourceFile[] =>
  Object.entries(assets).map(([path, content]) => SourceFile.make({ path, content }));

/** Node hosts read the same package assets that Workers embed at build time. */
export const readExecutorSkills = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entry = yield* path.fromFileUrl(
    new URL(
      import.meta.resolve("@executor-js/app-templates/executor/skills/app-authoring/SKILL.md"),
    ),
  );
  const directory = path.dirname(entry);
  const files = yield* Effect.forEach(
    (yield* fs.readDirectory(directory)).filter((name) => name.endsWith(".md")),
    (name) =>
      fs
        .readFileString(path.join(directory, name))
        .pipe(Effect.map((content) => [`skills/app-authoring/${name}`, content] as const)),
  );
  const framework = yield* fs.readFileString(path.resolve(directory, "../../framework.ts"));
  const reference = yield* fs.readFileString(
    yield* path.fromFileUrl(new URL(import.meta.resolve("apps/framework-reference.json"))),
  );
  return executorSkillFiles({
    ...Object.fromEntries(files),
    "framework.ts": framework,
    "framework-reference.json": reference,
  });
}).pipe(
  Effect.mapError(
    () =>
      new TemplateError({ reason: "Build apps before loading the Executor authoring reference." }),
  ),
);
