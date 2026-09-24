/** Read current skill catalogs through the caller's authorized app and profile targets. */
import { Effect } from "effect";
import type { AppSkillCatalog } from "@executor-js/sdk/core";
import type { McpBackend } from "../contracts/backend.ts";
import { defaultMcpRuntimeLimits } from "../contracts/execute.ts";
import {
  SkillAccessFailed,
  type SkillsInput,
  type SkillsResult,
  type SkillSummary,
} from "../contracts/skills.ts";
import { diagnostic } from "./diagnostics.ts";

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
const failure = (error: Error) => new SkillAccessFailed({ reason: diagnostic(error) });

/** Resolve a slug only within authorized apps. Reference reads can pin the document's deployment. */
export const skills = <E extends Error>(
  input: typeof SkillsInput.Type,
  backend: McpBackend<E>,
): Effect.Effect<typeof SkillsResult.Type, SkillAccessFailed> =>
  Effect.gen(function* () {
    const apps = yield* backend.listApps().pipe(Effect.mapError(failure));
    if (input.app === undefined) {
      const catalogs = yield* Effect.forEach(
        apps,
        (app) =>
          Effect.gen(function* () {
            const targets = yield* backend
              .listTargets({ app: app.id })
              .pipe(Effect.mapError(failure));
            const results = yield* Effect.forEach(
              targets,
              (target) =>
                backend
                  .listSkills({
                    app: app.id,
                    ...(target.kind === "app"
                      ? {}
                      : { profile: target.id, expectedProfileRevision: target.revision }),
                  })
                  .pipe(Effect.map(summaries), Effect.mapError(failure)),
              { concurrency: defaultMcpRuntimeLimits.discoveryConcurrency },
            );
            return results.flat();
          }),
        { concurrency: defaultMcpRuntimeLimits.discoveryConcurrency },
      );
      return { skills: catalogs.flat() };
    }
    const matches = apps.filter((app) => app.slug === input.app);
    const app = matches[0];
    if (app === undefined) return yield* new SkillAccessFailed({ reason: "AppNotFound" });
    if (matches.length !== 1) return yield* new SkillAccessFailed({ reason: "AppSlugAmbiguous" });
    const targets = yield* backend.listTargets({ app: app.id }).pipe(Effect.mapError(failure));
    const target =
      input.profile === undefined
        ? (targets.find((target) => target.kind === "app") ??
          (targets.length === 1 ? targets[0] : undefined))
        : targets.find((target) => target.kind === "profile" && target.id === input.profile);
    if (target === undefined)
      return yield* new SkillAccessFailed({
        reason: targets.length > 1 ? "ProfileRequired" : "AccountRequired",
      });
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
