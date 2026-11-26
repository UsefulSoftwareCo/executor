import { SourceTextFile as SourceFile } from "@executor-js/sdk/core";
import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { TemplateError } from "../contracts/templates.ts";

export const executorSkillFiles = (
  assets: Readonly<Record<string, string>>,
): readonly SourceFile[] =>
  Object.entries(assets).map(([path, content]) => SourceFile.make({ path, content }));

const skillAssetLimits = { files: 100, fileBytes: 256 * 1024 } as const;

const skillAssetInvalid = (reason: string) =>
  new TemplateError({ code: "authoring_reference", reason });

export const readSkillDocuments = Effect.fnUntraced(function* (skillsRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(skillsRoot);
  const walk = (
    relative: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<ReadonlyArray<string>>, TemplateError | PlatformError> =>
    Effect.gen(function* () {
      const directory = path.join(root, ...relative);
      const entries = (yield* fs.readDirectory(directory))
        .filter((entry) => !entry.startsWith("."))
        .sort();
      const nested = yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          const segments = [...relative, entry];
          const file = path.join(directory, entry);
          if ((yield* fs.realPath(file)) !== file)
            return yield* skillAssetInvalid(
              `Executor skill path ${segments.join("/")} is a symbolic link. Publish the file itself.`,
            );
          const info = yield* fs.stat(file);
          if (info.type === "Directory") return yield* walk(segments);
          if (info.type !== "File" || segments.length < 2 || !entry.endsWith(".md")) return [];
          if (Number(info.size) > skillAssetLimits.fileBytes)
            return yield* skillAssetInvalid(
              `Executor skill file ${segments.join("/")} is ${Number(info.size)} bytes; each file may be at most ${skillAssetLimits.fileBytes}.`,
            );
          return [segments];
        }),
      );
      return nested.flat();
    });
  const files = yield* walk([]);
  if (files.length > skillAssetLimits.files)
    return yield* skillAssetInvalid(
      `The Executor skills have ${files.length} files; they may have at most ${skillAssetLimits.files}.`,
    );
  return yield* Effect.forEach(files, (segments) =>
    fs
      .readFileString(path.join(root, ...segments))
      .pipe(Effect.map((content) => [`skills/${segments.join("/")}`, content] as const)),
  );
});

export const readExecutorSkillDocuments = Effect.gen(function* () {
  const path = yield* Path.Path;
  return yield* readSkillDocuments(
    path.dirname(
      path.dirname(
        yield* path.fromFileUrl(
          new URL(
            import.meta.resolve("@executor-js/app-templates/executor/skills/executor/SKILL.md"),
          ),
        ),
      ),
    ),
  );
});

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
  Effect.catchTag("PlatformError", () =>
    Effect.fail(
      new TemplateError({
        code: "authoring_reference",
        reason: "Build apps before loading the Executor authoring reference.",
      }),
    ),
  ),
);
