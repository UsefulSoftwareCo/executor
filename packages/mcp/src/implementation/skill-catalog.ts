/**
 * The caller's app skills under the MCP Skills extension: every skill of every app the caller can
 * see, read through the same catalogs, grants and linked accounts as the `skills` tool.
 */
import { Clock, Effect, Fiber, Option, Schema } from "effect";
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

/**
 * How long one app's skills may take in a listing. A listing answers without an app that takes
 * longer; its load continues, so a later listing serves it, and its skills are served by URI,
 * which waits for them.
 */
export const skillListingAppMillis = 5_000;
/** How long a listing's load of one app's skills may run on after the listing stops waiting. */
const skillLoadMillis = 60_000;

type ListedApp = Pick<App, "id" | "name" | "slug" | "activeVersion">;
type Skill = AppSkillBundle["skills"][number];

/**
 * `skill://<app slug>/<skill name>/<path>`: the app slug is the tool namespace too. Slugs and
 * skill names need no escaping; a file path is percent-encoded segment by segment, so a name such
 * as `Q&A #1.md` is one path segment of a URI with no query or fragment.
 */
const skillUri = (app: ListedApp, skill: Skill) => `${scheme}${app.slug}/${skill.name}/SKILL.md`;
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const toOptions = (app: ListedApp, skill: Skill): McpServer.SkillOptions => ({
  uri: skillUri(app, skill),
  files: Object.fromEntries(skill.files.map((file) => [encodePath(file.path), file.content])) as {
    "SKILL.md": string;
  } & Record<string, string>,
});

/** A URI this server could serve: an app slug, a skill name and a decoded path within the skill. */
const parse = (uri: string) => {
  if (!uri.startsWith(scheme)) return undefined;
  const [slug, name, ...rest] = uri.slice(scheme.length).split("/");
  const segments = Option.liftThrowable(() => rest.map(decodeURIComponent))();
  if (Option.isNone(segments)) return undefined;
  const file = segments.value.join("/");
  // A decoded segment that holds a separator, or a path with `..`, is not a file of the skill.
  if (segments.value.some((segment) => segment.includes("/"))) return undefined;
  if (!Schema.is(AppSlug)(slug) || !Schema.is(AppSkillName)(name)) return undefined;
  if (!Schema.is(SourceFilePath)(file)) return undefined;
  return { slug, name, file };
};

/** Apps are addressed by slug; a slug two visible apps share addresses neither. */
const bySlug = (apps: ReadonlyArray<ListedApp>) => {
  const counts = new Map<string, number>();
  for (const app of apps) counts.set(app.slug, (counts.get(app.slug) ?? 0) + 1);
  return apps.filter((app) => counts.get(app.slug) === 1);
};

/**
 * The apps, by version, whose listing load is running in this process or isolate. A listing that
 * finds one running leaves that app out, as it leaves out a slow app, instead of starting another
 * load, so loads of an app that never answers cannot stack. It is one set for every catalog here,
 * because hosts build a protocol server, and so a catalog, per client: only a shared mark bounds
 * an app's loads across callers. Nothing passes between listings but this mark: each load runs as
 * the caller that started it and answers only that caller. App IDs are unique across owners.
 * A mark expires with its load's bound, even if that load has not yet stopped.
 */
const loading = new Map<string, { readonly until: number }>();

/** A failure that leaves something out is reported, by name only: messages can carry app text. */
const leftOut = (error: Error) =>
  Effect.logWarning("Left an app's skills out of the MCP Skills extension").pipe(
    Effect.annotateLogs({ error: error.name }),
  );

/**
 * The extension's catalog for the request's caller. A listing serves each app's kept catalog as
 * the `skills` tool's index does, so it loads an app only when nothing is kept. `skills/get` and
 * file reads read one app's current catalog, as the tool's reads do, so a client whose file no
 * longer matches its listing gets the current entry from `skills/get`. One app that fails, is slow
 * or needs an account the caller has not linked is left out; it never fails the listing.
 */
export const skillCatalog = <E extends Error>(backend: McpBackend<E>): McpServer.SkillCatalog => {
  // An app with no active version has no skills to serve, and nothing to mark while loading.
  const apps = backend
    .listApps()
    .pipe(Effect.map((apps) => bySlug(apps).filter((app) => app.activeVersion !== null)));
  // Reads the version the caller's listing of apps named, so a mark names what is loaded.
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
  const listingLoad = (app: ListedApp) => {
    const key = JSON.stringify([app.id, app.activeVersion]);
    // The listing stops waiting for a slow app, not its load: the load finishes on its own and
    // keeps the app's catalog, so a later listing serves it. A load that never answers ends at its
    // own bound.
    const load = bundle(app, { refreshStale: false }).pipe(
      Effect.map(({ skills }) => skills.map((skill) => toOptions(app, skill))),
      Effect.timeoutOption(skillLoadMillis),
      Effect.map((listed) => (listed._tag === "Some" ? listed.value : [])),
    );
    // Checking, marking and starting the load happen in one synchronous step.
    return Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.withFiber((parent) =>
        Effect.sync(() => {
          const running = loading.get(key);
          if (running !== undefined && now < running.until) return undefined;
          const mark = { until: now + skillLoadMillis };
          loading.set(key, mark);
          const clear = () => {
            if (loading.get(key) === mark) loading.delete(key);
          };
          try {
            const started = Effect.runForkWith(parent.context)(load);
            started.addObserver(clear);
            return started;
          } catch (cause) {
            clear();
            throw cause;
          }
        }),
      ),
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
        Effect.forEach(
          apps,
          (app) =>
            listingLoad(app).pipe(
              Effect.flatMap((load) =>
                load === undefined
                  ? Effect.succeed(Option.none())
                  : Fiber.join(load).pipe(Effect.timeoutOption(skillListingAppMillis)),
              ),
              Effect.map((listed) => (listed._tag === "Some" ? listed.value : [])),
              // Most members never link accounts to most apps; those apps list no skills.
              Effect.catchIf(Schema.is(AccountRequired), () => Effect.succeed([])),
              Effect.catch((error) => leftOut(error).pipe(Effect.as([]))),
            ),
          { concurrency: defaultMcpRuntimeLimits.discoveryConcurrency },
        ),
      ),
      Effect.map((listed) => listed.flat()),
      Effect.catch((error) => leftOut(error).pipe(Effect.as([]))),
      Effect.withSpan("mcp.skills.extension.list"),
    ),
    // Only a `SKILL.md` URI names a skill, so any other is answered without loading its app.
    get: (uri) =>
      (parse(uri)?.file === "SKILL.md" ? skillAt(uri) : Effect.succeed(undefined)).pipe(
        Effect.map((found) =>
          found === undefined || found.file !== "SKILL.md"
            ? undefined
            : toOptions(found.app, found.skill),
        ),
        Effect.catchIf(Schema.is(AccountRequired), () => Effect.succeed(undefined)),
        // The extension answers an unreadable skill as one it does not serve.
        Effect.catch((error) => leftOut(error).pipe(Effect.as(undefined))),
        Effect.withSpan("mcp.skills.extension.get"),
      ),
    read: (uri) =>
      skillAt(uri).pipe(
        Effect.map((found) => found?.skill.files.find((file) => file.path === found.file)?.content),
        Effect.catchIf(Schema.is(AccountRequired), () => Effect.succeed(undefined)),
        // Reported and summarized as the skills tool reports a failed read.
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
