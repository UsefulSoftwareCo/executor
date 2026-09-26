import { storedApp, storedDeployment } from "./apps.ts";
import { evaluationFailure, snapshot as invocation } from "./tools.ts";
import { AppSkills } from "apps/contracts";
import { AppEvaluationFailed } from "../contracts/tools.ts";
import { AppNotDeployed } from "../contracts/apps.ts";
/** Skill reads project one authorized runtime catalog, or a retained pre-capability folder. */
import { Crypto, Effect, Encoding, Schema } from "effect";
import type { BlobStorage } from "../contracts/blobs.ts";
import { AppSkillInputs, AppSkillNotFound, SkillRevisionChanged } from "../contracts/skills.ts";
import { RequestInvalid, StorageError } from "../contracts/shared.ts";
import type { Runtime } from "../contracts/runtime.ts";
import type { Query } from "./database.ts";
import type { Declarations } from "./declarations.ts";
import { readDeploymentSource } from "./deployment-source.ts";
import { prepareAppSkills } from "./skill-source.ts";

/** Runtime skill results; only a catalog known to have no live loader is reused. */
const Catalog = Schema.Struct({
  skills: Schema.Unknown,
  dynamic: Schema.optionalKey(Schema.Boolean),
});
const StaticCatalog = Schema.Struct({ skills: Schema.Unknown, dynamic: Schema.Literal(false) });

/** Sorted catalog digest; equal content has equal revisions. */
const catalogRevision = (crypto: Crypto.Crypto, skills: typeof AppSkills.Type) =>
  crypto.digest("SHA-256", new TextEncoder().encode(JSON.stringify(skills))).pipe(
    Effect.map(Encoding.encodeHex),
    Effect.mapError(() => new StorageError()),
  );
const sorted = (skills: typeof AppSkills.Type) =>
  [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => ({
      ...skill,
      files: [...skill.files].sort((a, b) => a.path.localeCompare(b.path)),
    }));

/**
 * Bind skill reads to the app's code lineage. Builds with the skills capability are evaluated
 * with the selected profile; their catalog is served stale-while-revalidate within its bound.
 */
export const makeSkills = (
  db: Query,
  runtime: Runtime,
  crypto: Crypto.Crypto,
  declarations: Declarations,
  blobs: BlobStorage,
) => {
  const snapshot = (input: typeof AppSkillInputs.list.Type) =>
    Effect.gen(function* () {
      const app = yield* storedApp(db, input);
      const deployment = input.deployment ?? app.activeDeployment;
      if (deployment === null) return yield* new AppNotDeployed({ app: app.id });
      const retained = yield* storedDeployment(db, app, deployment);
      const decode = (value: unknown) =>
        Schema.decodeUnknownEffect(AppSkills)(value).pipe(
          Effect.map(sorted),
          Effect.mapError(
            () =>
              new AppEvaluationFailed({
                app: app.id,
                deployment,
                reason: "Invalid skill catalog",
              }),
          ),
        );
      // A retained framework that predates dynamic skills cannot receive the new command.
      // Its immutable bundled skills remain readable until its owner deploys a newer build.
      const capabilities = retained.requirements.capabilities;
      const live =
        capabilities?.skills === true
          ? yield* Effect.gen(function* () {
              const state = yield* invocation(db, { ...input, deployment });
              // Builds that report their sources keep catalogs without a live loader. A catalog
              // from `dynamicSkills`, or from an older build that cannot say, is read every time.
              const sources = capabilities.skillSources === true;
              const known = input.revision;
              const catalog = yield* declarations.read(
                "skills",
                state,
                (context) =>
                  runtime
                    .skills({ app: app.id, build: state.deployment.build, sources, ...context })
                    .pipe(
                      Effect.mapError((error) =>
                        evaluationFailure(
                          { app: app.id, deployment },
                          error,
                          "Skill evaluation failed",
                        ),
                      ),
                    ),
                {
                  retain: (value) => Schema.is(StaticCatalog)(value),
                  // A caller holding another revision rereads rather than receive an older one.
                  current: (value) =>
                    known === undefined
                      ? Effect.succeed(true)
                      : Schema.decodeUnknownEffect(StaticCatalog)(value).pipe(
                          Effect.flatMap((catalog) => decode(catalog.skills)),
                          Effect.flatMap((skills) => catalogRevision(crypto, skills)),
                          Effect.map((revision) => revision === known),
                          Effect.orElseSucceed(() => false),
                        ),
                },
              );
              const skills = yield* Schema.decodeUnknownEffect(Catalog)(catalog).pipe(
                Effect.mapError(
                  () =>
                    new AppEvaluationFailed({
                      app: app.id,
                      deployment,
                      reason: "Invalid skill catalog",
                    }),
                ),
                Effect.flatMap((catalog) => decode(catalog.skills)),
              );
              return { skills, profile: state.profile };
            })
          : {
              skills: yield* readDeploymentSource(blobs, retained.id).pipe(
                Effect.flatMap(prepareAppSkills),
                Effect.flatMap(decode),
              ),
              profile: undefined,
            };
      const skills = live.skills;
      const revision = yield* catalogRevision(crypto, skills);
      if (input.revision !== undefined && input.revision !== revision)
        return yield* new SkillRevisionChanged({
          app: app.id,
          expected: input.revision,
          current: revision,
        });
      return {
        app: { id: app.id, name: app.name, slug: app.slug },
        deployment: retained.id,
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
