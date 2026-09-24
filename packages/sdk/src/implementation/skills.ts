import { storedDeployment } from "./apps.ts";
import { snapshot as invocation, resolve } from "./tools.ts";
import { AppSkills } from "apps/contracts";
import { AppEvaluationFailed } from "../contracts/tools.ts";
import { AppNotDeployed } from "../contracts/apps.ts";
/** Skill reads project one authorized runtime catalog, or a retained pre-capability folder. */
import { Crypto, Effect, Encoding, Schema } from "effect";
import type { Executor } from "../contracts/executor.ts";
import { AppSkillInputs, AppSkillNotFound, SkillRevisionChanged } from "../contracts/skills.ts";
import { RequestInvalid, StorageError } from "../contracts/shared.ts";
import { prepareAppSkills } from "./skill-source.ts";

/** Bind skill reads to the same app lookup and retained-source lineage used by deployment inspection. */
export const makeSkills = (
  apps: Pick<Executor["apps"], "get" | "source">,
  db: import("./database.ts").Query,
  runtime: import("../contracts/runtime.ts").Runtime,
  resolveAccount: ReturnType<typeof import("./oauth.ts").makeOAuth>["resolve"],
  crypto: Crypto.Crypto,
  lifecycle?: import("../contracts/executor.ts").ResourceLifecycle,
) => {
  const snapshot = (input: typeof AppSkillInputs.list.Type) =>
    Effect.gen(function* () {
      const app = yield* apps.get(input);
      const deployment = input.deployment ?? app.activeDeployment;
      if (deployment === null) return yield* new AppNotDeployed({ app: app.id });
      const source = yield* apps.source({
        ...input,
        deployment,
      });
      const retained = yield* storedDeployment(db, app, deployment);
      // A retained framework that predates dynamic skills cannot receive the new command.
      // Its immutable bundled skills remain readable until its owner deploys a newer build.
      const live =
        retained.requirements.capabilities?.skills === true
          ? yield* Effect.gen(function* () {
              const state = yield* invocation(db, { ...input, deployment });
              const context = yield* resolve(state, resolveAccount, lifecycle);
              const skills = yield* runtime
                .skills({ app: app.id, build: state.deployment.build, ...context })
                .pipe(
                  Effect.mapError(
                    () =>
                      new AppEvaluationFailed({
                        app: app.id,
                        deployment,
                        reason: "Skill evaluation failed",
                      }),
                  ),
                );
              return { skills, profile: state.profile };
            })
          : { skills: yield* prepareAppSkills(source.files), profile: undefined };
      const skills = yield* Schema.decodeUnknownEffect(AppSkills)(live.skills).pipe(
        Effect.mapError(
          () =>
            new AppEvaluationFailed({ app: app.id, deployment, reason: "Invalid skill catalog" }),
        ),
        Effect.map((skills) =>
          [...skills]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((skill) => ({
              ...skill,
              files: [...skill.files].sort((a, b) => a.path.localeCompare(b.path)),
            })),
        ),
      );
      const revision = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(JSON.stringify(skills)))
        .pipe(
          Effect.map(Encoding.encodeHex),
          Effect.mapError(() => new StorageError()),
        );
      if (input.revision !== undefined && input.revision !== revision)
        return yield* new SkillRevisionChanged({
          app: app.id,
          expected: input.revision,
          current: revision,
        });
      return {
        app: { id: app.id, name: app.name, slug: app.slug },
        deployment: source.id,
        revision,
        skills,
        ...(live.profile === undefined
          ? {}
          : { profile: live.profile.id, profileRevision: live.profile.revision }),
      };
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
            const { skills, ...identity } = yield* snapshot(input);
            const { app } = identity;
            const skill = skills.find((skill) => skill.name === input.name);
            const file = input.file ?? "SKILL.md";
            const resource = skill?.files.find((resource) => resource.path === file);
            if (skill === undefined || resource === undefined)
              return yield* new AppSkillNotFound({ app: app.id, name: input.name, file });
            const { files, ...metadata } = skill;
            return {
              ...metadata,
              ...identity,
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
