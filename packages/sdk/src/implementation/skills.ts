import { AppNotDeployed } from "../contracts/apps.ts";
/** Static resources follow the existing source reader, independent of the execution runtime and credentials. */
import { Effect, Schema } from "effect";
import type { Executor } from "../contracts/executor.ts";
import { AppSkillInputs, AppSkillNotFound } from "../contracts/skills.ts";
import { RequestInvalid } from "../contracts/shared.ts";
import { prepareAppSkills } from "./skill-source.ts";

/** Bind skill reads to the same app lookup and retained-source lineage used by deployment inspection. */
export const makeSkills = (apps: Pick<Executor["apps"], "get" | "source">) => {
  const snapshot = (input: typeof AppSkillInputs.list.Type) =>
    Effect.gen(function* () {
      const app = yield* apps.get(input);
      const deployment = input.deployment ?? app.activeDeployment;
      if (deployment === null) return yield* new AppNotDeployed({ app: app.id });
      const source = yield* apps.source({
        ...input,
        deployment,
      });
      const skills = yield* prepareAppSkills(source.files);
      return { app: { id: app.id, name: app.name, slug: app.slug }, deployment: source.id, skills };
    });
  return {
    bundle: (input: typeof AppSkillInputs.list.Type) =>
      Schema.decodeUnknownEffect(AppSkillInputs.list)(input).pipe(
        Effect.mapError(() => new RequestInvalid()),
        Effect.flatMap(snapshot),
        Effect.withSpan("sdk.skills.bundle"),
      ),
    list: (input: typeof AppSkillInputs.list.Type) =>
      Schema.decodeUnknownEffect(AppSkillInputs.list)(input).pipe(
        Effect.mapError(() => new RequestInvalid()),
        Effect.flatMap(snapshot),
        Effect.map((snapshot) => ({
          ...snapshot,
          skills: snapshot.skills.map(({ files: _files, ...metadata }) => metadata),
        })),
        Effect.withSpan("sdk.skills.list"),
      ),
    read: (input: typeof AppSkillInputs.read.Type) =>
      Schema.decodeUnknownEffect(AppSkillInputs.read)(input).pipe(
        Effect.mapError(() => new RequestInvalid()),
        Effect.flatMap((input) =>
          Effect.gen(function* () {
            const { app, deployment, skills } = yield* snapshot(input);
            const skill = skills.find((skill) => skill.name === input.name);
            const file = input.file ?? "SKILL.md";
            const resource = skill?.files.find((resource) => resource.path === file);
            if (skill === undefined || resource === undefined)
              return yield* new AppSkillNotFound({ app: app.id, name: input.name, file });
            const { files, ...metadata } = skill;
            return {
              ...metadata,
              app,
              deployment,
              file,
              content: resource.content,
              files: files.map((file) => file.path),
            };
          }),
        ),
        Effect.withSpan("sdk.skills.read"),
      ),
  };
};
