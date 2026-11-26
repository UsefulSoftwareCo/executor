import { storedApp, storedVersion } from "./apps.ts";
import { snapshot as invocation } from "./tools.ts";
import { appProviderFailure } from "./provider-error.ts";
import { AppSkills, ProviderError } from "apps/contracts";
import { AppEvaluationFailed, evaluationFailure } from "../contracts/tools.ts";
import { AppNotDeployed } from "../contracts/apps.ts";
import { Effect, Schema } from "effect";
import type { HostCrypto } from "./host-crypto.ts";
import { Digest } from "effect/crypto";
import { Hex } from "effect/encoding";
import type { BlobStorage } from "../contracts/blobs.ts";
import type { CatalogReadOptions } from "../contracts/declarations.ts";
import { AppSkillInputs, AppSkillNotFound, SkillRevisionChanged } from "../contracts/skills.ts";
import { RequestInvalid } from "../contracts/shared.ts";
import type { Runtime } from "../contracts/runtime.ts";
import type { Query } from "./database.ts";
import type { Declarations } from "./declarations.ts";
import { readVersionSource } from "./version-source.ts";
import { prepareAppSkills } from "./skill-source.ts";

const Catalog = Schema.Struct({
  skills: Schema.Unknown,
  dynamic: Schema.optionalKey(Schema.Boolean),
  cached: Schema.optionalKey(Schema.Boolean),
});
const Published = Schema.Struct({ skills: Schema.Unknown, cached: Schema.Literal(true) });
const Reusable = Schema.Union([
  Schema.Struct({ skills: Schema.Unknown, dynamic: Schema.Literal(false) }),
  Published,
]);

const catalogRevision = (crypto: HostCrypto, skills: typeof AppSkills.Type) =>
  crypto.digest
    .digest(Digest.sha256, new TextEncoder().encode(JSON.stringify(skills)))
    .pipe(Effect.map(Hex.encode));
const sorted = (skills: typeof AppSkills.Type) =>
  [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => ({
      ...skill,
      files: [...skill.files].sort((a, b) => a.path.localeCompare(b.path)),
    }));

export const makeSkills = (
  db: Query,
  runtime: Runtime,
  crypto: HostCrypto,
  declarations: Declarations,
  blobs: BlobStorage,
) => {
  const snapshot = (input: typeof AppSkillInputs.list.Type, read: CatalogReadOptions = {}) =>
    Effect.gen(function* () {
      const app = yield* storedApp(db, input);
      const version = input.version ?? app.activeVersion;
      if (version === null) return yield* new AppNotDeployed({ app: app.id });
      const retained = yield* storedVersion(db, app, version);
      const decode = (value: unknown) =>
        Schema.decodeUnknownEffect(AppSkills)(value).pipe(
          Effect.map(sorted),
          Effect.mapError(
            () =>
              new AppEvaluationFailed({
                app: app.id,
                version,
                reason: "Invalid skill catalog",
              }),
          ),
        );
      const capabilities = retained.requirements.capabilities;
      const live =
        capabilities?.skills === true
          ? yield* Effect.gen(function* () {
              const state = yield* invocation(db, { ...input, version });
              const sources = capabilities.skillSources === true;
              const known = input.revision;
              const catalog = yield* declarations.read(
                "skills",
                state,
                (context) =>
                  runtime
                    .skills({
                      app: app.id,
                      build: state.version.build,
                      hostApi: declarations.hostApi(state.version),
                      sources,
                      ...context,
                    })
                    .pipe(
                      Effect.mapError((error) =>
                        Schema.is(ProviderError)(error)
                          ? appProviderFailure(state, error)
                          : evaluationFailure(
                              { app: app.id, version },
                              error,
                              "Skill evaluation failed",
                            ),
                      ),
                    ),
                {
                  ...(read.refreshStale === undefined ? {} : { refreshStale: read.refreshStale }),
                  retain: (value) => Schema.is(Reusable)(value),
                  revalidate: (value) => known === undefined && Schema.is(Published)(value),
                  current: (value) =>
                    known === undefined
                      ? Effect.succeed(true)
                      : Schema.decodeUnknownEffect(Catalog)(value).pipe(
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
                      version,
                      reason: "Invalid skill catalog",
                    }),
                ),
                Effect.flatMap((catalog) => decode(catalog.skills)),
              );
              return skills;
            })
          : yield* readVersionSource(blobs, retained.id).pipe(
              Effect.flatMap(prepareAppSkills),
              Effect.flatMap(decode),
            );
      const skills = live;
      const revision = yield* catalogRevision(crypto, skills);
      if (input.revision !== undefined && input.revision !== revision)
        return yield* new SkillRevisionChanged({
          app: app.id,
          expected: input.revision,
          current: revision,
        });
      return {
        app: { id: app.id, name: app.name, slug: app.slug },
        version: retained.id,
        revision,
        skills,
      };
    });
  return {
    bundle: (input: typeof AppSkillInputs.list.Type, options?: CatalogReadOptions) =>
      Schema.decodeUnknownEffect(AppSkillInputs.list)(input).pipe(
        Effect.mapError(() => new RequestInvalid()),
        Effect.flatMap((input) => snapshot(input, options)),
        Effect.withSpan("sdk.skills.bundle"),
      ),
    list: (input: typeof AppSkillInputs.list.Type, options?: CatalogReadOptions) =>
      Schema.decodeUnknownEffect(AppSkillInputs.list)(input).pipe(
        Effect.mapError(() => new RequestInvalid()),
        Effect.flatMap((input) => snapshot(input, options)),
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
