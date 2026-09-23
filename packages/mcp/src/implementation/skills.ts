/** Read immutable skill source through the caller's authorized backend, never through app evaluation. */
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
          backend.listSkills({ app: app.id }).pipe(Effect.map(summaries), Effect.mapError(failure)),
        { concurrency: defaultMcpRuntimeLimits.discoveryConcurrency },
      );
      return { skills: catalogs.flat() };
    }
    const matches = apps.filter((app) => app.slug === input.app);
    const app = matches[0];
    if (app === undefined) return yield* new SkillAccessFailed({ reason: "AppNotFound" });
    if (matches.length !== 1) return yield* new SkillAccessFailed({ reason: "AppSlugAmbiguous" });
    if (input.name === undefined) {
      const catalog = yield* backend
        .listSkills({ app: app.id, deployment: input.deployment })
        .pipe(Effect.mapError(failure));
      return { skills: summaries(catalog) };
    }
    const document = yield* backend
      .readSkill({ app: app.id, name: input.name, deployment: input.deployment, file: input.file })
      .pipe(Effect.mapError(failure));
    return document;
  });
