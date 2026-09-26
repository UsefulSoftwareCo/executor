/** Read current skill catalogs through the caller's authorized app and profile targets. */
import { Effect } from "effect";
import type { AppSkillCatalog } from "@executor-js/sdk/core";
import type { McpBackend } from "../contracts/backend.ts";
import { defaultMcpRuntimeLimits } from "../contracts/execute.ts";
import {
  SkillAccessFailed,
  SkillAccountRequired,
  SkillAppNotFound,
  SkillAppSlugAmbiguous,
  SkillProfileRequired,
  type SkillsFailure,
  type SkillsInput,
  type SkillsResult,
  type SkillSummary,
} from "../contracts/skills.ts";
import { diagnosticSummary } from "./diagnostics.ts";

const summaries = (catalog: AppSkillCatalog): readonly (typeof SkillSummary.Type)[] =>
  catalog.skills.map((skill) => ({
    ...skill,
    app: catalog.app,
    deployment: catalog.deployment,
    revision: catalog.revision,
    ...(catalog.profile === undefined
      ? {}
      : { profile: catalog.profile, profileRevision: catalog.profileRevision }),
  }));
const failure = (error: Error) => new SkillAccessFailed({ reason: diagnosticSummary(error) });

/** Resolve a slug only within authorized apps. Reference reads can pin the document's deployment. */
export const skills = <E extends Error>(
  input: typeof SkillsInput.Type,
  backend: McpBackend<E>,
): Effect.Effect<typeof SkillsResult.Type, SkillsFailure> =>
  Effect.gen(function* () {
    const apps = yield* backend.listApps().pipe(Effect.mapError(failure));
    if (input.app === undefined) {
      // One broken, undeployed or account-less app must not hide every other app's skills.
      const listed = yield* Effect.forEach(
        apps,
        (app) =>
          backend.listTargets({ app: app.id }).pipe(
            Effect.flatMap((targets) =>
              Effect.forEach(
                targets,
                (target) =>
                  backend
                    .listSkills({
                      app: app.id,
                      ...(target.kind === "app"
                        ? {}
                        : { profile: target.id, expectedProfileRevision: target.revision }),
                    })
                    .pipe(
                      Effect.map((catalog) => ({ skills: summaries(catalog), unavailable: [] })),
                      Effect.catch((error) =>
                        Effect.succeed({
                          skills: [],
                          unavailable: [
                            {
                              app: app.id,
                              name: app.name,
                              ...(target.kind === "profile" ? { profile: target.id } : {}),
                              reason: diagnosticSummary(error),
                            },
                          ],
                        }),
                      ),
                    ),
                { concurrency: defaultMcpRuntimeLimits.discoveryConcurrency },
              ),
            ),
            Effect.catch((error) =>
              Effect.succeed([
                {
                  skills: [],
                  unavailable: [{ app: app.id, name: app.name, reason: diagnosticSummary(error) }],
                },
              ]),
            ),
          ),
        { concurrency: defaultMcpRuntimeLimits.discoveryConcurrency },
      );
      const results = listed.flat();
      return {
        skills: results.flatMap((result) => result.skills),
        unavailableApps: results.flatMap((result) => result.unavailable),
      };
    }
    const matches = apps.filter((app) => app.slug === input.app);
    const app = matches[0];
    if (app === undefined) return yield* new SkillAppNotFound({ app: input.app });
    if (matches.length !== 1) return yield* new SkillAppSlugAmbiguous({ app: input.app });
    const targets = yield* backend.listTargets({ app: app.id }).pipe(Effect.mapError(failure));
    const target =
      input.profile === undefined
        ? (targets.find((target) => target.kind === "app") ??
          (targets.length === 1 ? targets[0] : undefined))
        : targets.find((target) => target.kind === "profile" && target.id === input.profile);
    if (target === undefined) {
      const profiles = targets.flatMap((target) => (target.kind === "profile" ? [target.id] : []));
      return yield* profiles.length === 0
        ? new SkillAccountRequired({ app: input.app })
        : new SkillProfileRequired({ app: input.app, profiles });
    }
    const selection = {
      deployment: input.deployment,
      revision: input.revision,
      ...(target.kind === "app"
        ? {}
        : {
            profile: target.id,
            expectedProfileRevision: input.expectedProfileRevision ?? target.revision,
          }),
    };
    if (input.name === undefined) {
      const catalog = yield* backend
        .listSkills({ app: app.id, ...selection })
        .pipe(Effect.mapError(failure));
      return { skills: summaries(catalog) };
    }
    const document = yield* backend
      .readSkill({ app: app.id, name: input.name, ...selection, file: input.file })
      .pipe(Effect.mapError(failure));
    return document;
  });
