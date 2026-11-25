import { Effect, Schema } from "effect";
import {
  AccountChoiceUnsupported,
  AccountRequired,
  resolveLinkedAccounts,
  type App,
  type AppSkillCatalog,
} from "@executor-js/sdk/core";
import type { McpBackend } from "../contracts/backend.ts";
import { defaultMcpRuntimeLimits } from "../contracts/execute.ts";
import {
  SkillAccessFailed,
  SkillAccountRequired,
  SkillAppNotFound,
  SkillAppSlugAmbiguous,
  SkillsInput,
  SkillsInputInvalid,
  type SkillsFailure,
  type SkillsResult,
  type SkillSummary,
} from "../contracts/skills.ts";
import { diagnosticSummary, failureReference, reportFailure } from "./diagnostics.ts";

const summaries = (catalog: AppSkillCatalog): readonly (typeof SkillSummary.Type)[] =>
  catalog.skills.map((skill) => ({
    ...skill,
    app: catalog.app,
    version: catalog.version,
    revision: catalog.revision,
  }));
const failure = (error: Error) =>
  reportFailure(error).pipe(
    Effect.andThen(failureReference),
    Effect.flatMap((reference) =>
      Effect.fail(
        new SkillAccessFailed({
          reason: diagnosticSummary(error, { operation: "discover", reference }),
        }),
      ),
    ),
  );
const unavailable = <A extends object>(error: Error, entry: A) =>
  reportFailure(error).pipe(
    Effect.andThen(failureReference),
    Effect.map((reference) => ({
      ...entry,
      reason: diagnosticSummary(error, { operation: "discover", reference }),
    })),
  );

type ListedApp = Pick<App, "id" | "name" | "slug" | "activeVersion">;

export const skillAccounts = <E extends Error>(
  backend: McpBackend<E>,
  app: ListedApp,
  version: ListedApp["activeVersion"],
) =>
  backend
    .listAccounts({
      app: app.id,
      ...(version === null || version === app.activeVersion ? {} : { version }),
    })
    .pipe(
      Effect.flatMap((linked) =>
        resolveLinkedAccounts({ app: app.id, version, appLinks: {}, userLinks: linked }),
      ),
    );

export const decodeSkillsInput = (input: unknown) =>
  Schema.decodeUnknownEffect(SkillsInput)(input, { errors: "all" }).pipe(
    Effect.mapError((error) => new SkillsInputInvalid({ reason: error.message })),
  );

export const skills = <E extends Error>(
  input: typeof SkillsInput.Type,
  backend: McpBackend<E>,
): Effect.Effect<typeof SkillsResult.Type, SkillsFailure> =>
  Effect.gen(function* () {
    const apps = yield* backend.listApps().pipe(Effect.catch(failure));
    if (input.app === undefined) {
      const listed = yield* Effect.forEach(
        apps,
        (app) =>
          skillAccounts(backend, app, app.activeVersion).pipe(
            Effect.flatMap((accounts) =>
              backend.listSkills({ app: app.id, accounts }, { refreshStale: false }),
            ),
            Effect.map((catalog) => ({ skills: summaries(catalog), unavailable: [] })),
            Effect.catchIf(Schema.is(AccountRequired), () =>
              Effect.succeed({ skills: [], unavailable: [] }),
            ),
            Effect.catch((error) =>
              unavailable(error, { app: app.id, name: app.name }).pipe(
                Effect.map((entry) => ({ skills: [], unavailable: [entry] })),
              ),
            ),
          ),
        { concurrency: defaultMcpRuntimeLimits.discoveryConcurrency },
      );
      return {
        skills: listed.flatMap((result) => result.skills),
        unavailableApps: listed.flatMap((result) => result.unavailable),
      };
    }
    const matches = apps.filter((app) => app.slug === input.app);
    const app = matches[0];
    if (app === undefined) return yield* new SkillAppNotFound({ app: input.app });
    if (matches.length !== 1) return yield* new SkillAppSlugAmbiguous({ app: input.app });
    if (Object.hasOwn(input, "accounts"))
      return yield* failure(new AccountChoiceUnsupported({ app: app.id }));
    const slug = input.app;
    const accounts = yield* skillAccounts(backend, app, input.version ?? app.activeVersion).pipe(
      Effect.catch((error): Effect.Effect<never, SkillAccountRequired | SkillAccessFailed> =>
        Schema.is(AccountRequired)(error)
          ? Effect.fail(new SkillAccountRequired({ app: slug, scope: error.scope }))
          : failure(error),
      ),
    );
    const selection = { accounts, version: input.version, revision: input.revision };
    if (input.name === undefined) {
      const catalog = yield* backend
        .listSkills({ app: app.id, ...selection })
        .pipe(Effect.catch(failure));
      return { skills: summaries(catalog) };
    }
    return yield* backend
      .readSkill({ app: app.id, name: input.name, ...selection, file: input.file })
      .pipe(Effect.catch(failure));
  });
