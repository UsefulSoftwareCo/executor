import { Clock, Effect, Fiber, Option, Schema, Semaphore } from "effect";
import { McpSchema, type McpServer } from "effect/ai";
import {
  AccountRequired,
  AppSkillName,
  AppSlug,
  SourceFilePath,
  type App,
  type AppSkillBundle,
} from "@executor-js/sdk/core";
import type { McpBackend } from "../contracts/backend.ts";
import { defaultMcpRuntimeLimits } from "../contracts/execute.ts";
import { diagnosticSummary, failureReference, reportFailure } from "./diagnostics.ts";
import { skillAccounts } from "./skills.ts";

const scheme = "skill://";

export const skillListingMillis = 5_000;
const skillLoadMillis = 60_000;
const listingLoads = defaultMcpRuntimeLimits.discoveryConcurrency;

type ListedApp = Pick<App, "id" | "name" | "slug" | "activeVersion">;
type Skill = AppSkillBundle["skills"][number];

const skillUri = (app: ListedApp, skill: Skill) => `${scheme}${app.slug}/${skill.name}/SKILL.md`;
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const toOptions = (app: ListedApp, skill: Skill): McpServer.SkillOptions => ({
  uri: skillUri(app, skill),
  files: Object.fromEntries(skill.files.map((file) => [encodePath(file.path), file.content])) as {
    "SKILL.md": string;
  } & Record<string, string>,
});

const parse = (uri: string) => {
  if (!uri.startsWith(scheme)) return undefined;
  const [slug, name, ...rest] = uri.slice(scheme.length).split("/");
  const segments = Option.liftThrowable(() => rest.map(decodeURIComponent))();
  if (Option.isNone(segments)) return undefined;
  const file = segments.value.join("/");
  if (segments.value.some((segment) => segment.includes("/"))) return undefined;
  if (!Schema.is(AppSlug)(slug) || !Schema.is(AppSkillName)(name)) return undefined;
  if (!Schema.is(SourceFilePath)(file)) return undefined;
  return { slug, name, file };
};

const bySlug = (apps: ReadonlyArray<ListedApp>) => {
  const counts = new Map<string, number>();
  for (const app of apps) counts.set(app.slug, (counts.get(app.slug) ?? 0) + 1);
  return apps.filter((app) => counts.get(app.slug) === 1);
};

const loading = new Map<string, { readonly until: number }>();

const leftOut = (error: Error) =>
  Effect.logWarning("Left an app's skills out of the MCP Skills extension").pipe(
    Effect.annotateLogs({ error: error.name }),
  );

export const skillCatalog = <E extends Error>(backend: McpBackend<E>): McpServer.SkillCatalog => {
  const apps = backend
    .listApps()
    .pipe(Effect.map((apps) => bySlug(apps).filter((app) => app.activeVersion !== null)));
  const bundle = (app: ListedApp, options?: { readonly refreshStale: false }) =>
    skillAccounts(backend, app, app.activeVersion).pipe(
      Effect.flatMap((accounts) =>
        backend.bundleSkills(
          {
            app: app.id,
            accounts,
            ...(app.activeVersion === null ? {} : { version: app.activeVersion }),
          },
          options,
        ),
      ),
    );
  const listingLoad = (app: ListedApp, turns: Semaphore.Semaphore) => {
    const key = JSON.stringify([app.id, app.activeVersion]);
    const claim = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sync(() => {
        const running = loading.get(key);
        if (running !== undefined && now < running.until) return undefined;
        const mark = { until: now + skillLoadMillis };
        loading.set(key, mark);
        return mark;
      }),
    );
    const load = turns
      .withPermits(1)(
        Effect.acquireUseRelease(
          claim,
          (mark) =>
            mark === undefined
              ? Effect.succeed([])
              : bundle(app, { refreshStale: false }).pipe(
                  Effect.map(({ skills }) => skills.map((skill) => toOptions(app, skill))),
                ),
          (mark) =>
            Effect.sync(() => {
              if (mark !== undefined && loading.get(key) === mark) loading.delete(key);
            }),
        ),
      )
      .pipe(
        Effect.timeoutOption(skillLoadMillis),
        Effect.map((listed) => (listed._tag === "Some" ? listed.value : [])),
      );
    return Effect.withFiber((parent) =>
      Effect.sync(() => Effect.runForkWith(parent.context)(load)),
    );
  };
  const appBySlug = (slug: string) =>
    apps.pipe(Effect.map((apps) => apps.find((app) => app.slug === slug)));
  const skillAt = (uri: string) =>
    Effect.gen(function* () {
      const address = parse(uri);
      if (address === undefined) return undefined;
      const app = yield* appBySlug(address.slug);
      if (app === undefined) return undefined;
      const { skills } = yield* bundle(app);
      const skill = skills.find((skill) => skill.name === address.name);
      return skill === undefined ? undefined : { app, skill, file: address.file };
    });
  return {
    list: apps.pipe(
      Effect.flatMap((apps) =>
        Effect.flatMap(Semaphore.make(listingLoads), (turns) =>
          Effect.forEach(apps, (app) => listingLoad(app, turns)),
        ),
      ),
      Effect.flatMap((loads) =>
        Effect.forEach(
          loads,
          (load) =>
            Fiber.join(load).pipe(
              Effect.timeoutOption(skillListingMillis),
              Effect.map((listed) => (listed._tag === "Some" ? listed.value : [])),
              Effect.catchIf(Schema.is(AccountRequired), () => Effect.succeed([])),
              Effect.catch((error) => leftOut(error).pipe(Effect.as([]))),
            ),
          { concurrency: "unbounded" },
        ),
      ),
      Effect.map((listed) => listed.flat()),
      Effect.catch((error) => leftOut(error).pipe(Effect.as([]))),
      Effect.withSpan("mcp.skills.extension.list"),
    ),
    get: (uri) =>
      (parse(uri)?.file === "SKILL.md" ? skillAt(uri) : Effect.succeed(undefined)).pipe(
        Effect.map((found) =>
          found === undefined || found.file !== "SKILL.md"
            ? undefined
            : toOptions(found.app, found.skill),
        ),
        Effect.catchIf(Schema.is(AccountRequired), () => Effect.succeed(undefined)),
        Effect.catch((error) => leftOut(error).pipe(Effect.as(undefined))),
        Effect.withSpan("mcp.skills.extension.get"),
      ),
    read: (uri) =>
      skillAt(uri).pipe(
        Effect.map((found) => found?.skill.files.find((file) => file.path === found.file)?.content),
        Effect.catchIf(Schema.is(AccountRequired), () => Effect.succeed(undefined)),
        Effect.catch((error) =>
          reportFailure(error).pipe(
            Effect.andThen(failureReference),
            Effect.flatMap((reference) =>
              Effect.fail(
                new McpSchema.InternalError({
                  message: diagnosticSummary(error, { operation: "discover", reference }),
                }),
              ),
            ),
          ),
        ),
        Effect.withSpan("mcp.skills.extension.read"),
      ),
  };
};
