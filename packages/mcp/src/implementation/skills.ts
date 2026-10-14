/** Read current skill catalogs through the caller's authorized apps and linked accounts. */
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
  type SkillsFailure,
  type SkillsInput,
  type SkillsResult,
  type SkillSummary,
} from "../contracts/skills.ts";
import { diagnosticSummary, reportFailure } from "./diagnostics.ts";

const summaries = (catalog: AppSkillCatalog): readonly (typeof SkillSummary.Type)[] =>
  catalog.skills.map((skill) => ({
    ...skill,
    app: catalog.app,
    deployment: catalog.deployment,
    revision: catalog.revision,
  }));
/** The agent reads why a read failed; the original failure reports as the same REST read would. */
const failure = (error: Error) =>
  reportFailure(error).pipe(
    Effect.andThen(Effect.fail(new SkillAccessFailed({ reason: diagnosticSummary(error) }))),
  );
/** An app the listing could not read, listed beside the others' skills. */
const unavailable = <A extends object>(error: Error, entry: A) =>
  reportFailure(error).pipe(Effect.as({ ...entry, reason: diagnosticSummary(error) }));

type ListedApp = Pick<App, "id" | "name" | "slug" | "activeDeployment">;

/**
 * The accounts one app's skills are read with: the caller's linked accounts, as a tool call uses
 * them. Skill text may depend on the account.
 */
const skillAccounts = <E extends Error>(
  backend: McpBackend<E>,
  app: ListedApp,
  deployment: ListedApp["activeDeployment"],
) =>
  backend
    .listAccounts({
      app: app.id,
      ...(deployment === null || deployment === app.activeDeployment ? {} : { deployment }),
    })
    .pipe(
      Effect.flatMap((linked) =>
        resolveLinkedAccounts({ app: app.id, deployment, appLinks: {}, userLinks: linked }),
      ),
    );

/**
 * Resolve a slug only within authorized apps. Reference reads can pin the document's deployment.
 * A read that names accounts fails with `AccountChoiceUnsupported`, presented with its code and
 * status: reads never choose them.
 */
export const skills = <E extends Error>(
  input: typeof SkillsInput.Type,
  backend: McpBackend<E>,
): Effect.Effect<typeof SkillsResult.Type, SkillsFailure> =>
  Effect.gen(function* () {
    const apps = yield* backend.listApps().pipe(Effect.catch(failure));
    if (input.app === undefined) {
      // One broken, undeployed or account-less app must not hide every other app's skills.
      const listed = yield* Effect.forEach(
        apps,
        (app) =>
          skillAccounts(backend, app, app.activeDeployment).pipe(
            Effect.flatMap((accounts) =>
              // An index of every app's skills must not load each app to refresh it.
              backend.listSkills({ app: app.id, accounts }, { refreshStale: false }),
            ),
            Effect.map((catalog) => ({ skills: summaries(catalog), unavailable: [] })),
            // Most members never link accounts to most apps; those apps list no skills.
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
    // Presented as execute presents it, so the agent reads its code and status, not only its text.
    if (Object.hasOwn(input, "accounts"))
      return yield* failure(new AccountChoiceUnsupported({ app: app.id }));
    const slug = input.app;
    const accounts = yield* skillAccounts(
      backend,
      app,
      input.deployment ?? app.activeDeployment,
    ).pipe(
      Effect.catch((error): Effect.Effect<never, SkillAccountRequired | SkillAccessFailed> =>
        Schema.is(AccountRequired)(error)
          ? Effect.fail(new SkillAccountRequired({ app: slug, scope: error.scope }))
          : failure(error),
      ),
    );
    const selection = { accounts, deployment: input.deployment, revision: input.revision };
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
