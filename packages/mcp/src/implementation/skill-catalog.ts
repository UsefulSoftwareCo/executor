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
type Skill = AppSkillBundle["skills"][number] & {
  readonly namespace?: string;
  readonly localName?: string;
};
type SkillAddress = {
  readonly slug: string;
  readonly name: string;
  readonly namespace?: string;
  readonly localName?: string;
  readonly file: string;
};

const namespaceOf = (skill: Skill) => {
  if (skill.namespace !== undefined && skill.namespace !== "") return skill.namespace;
  const separator = skill.name.indexOf(":");
  return separator === -1 ? undefined : skill.name.slice(0, separator);
};
const localNameOf = (skill: Skill) => {
  if (skill.localName !== undefined && skill.localName !== "") return skill.localName;
  const separator = skill.name.indexOf(":");
  return separator === -1 ? skill.name : skill.name.slice(separator + 1);
};
const skillPath = (skill: Skill) => {
  const namespace = namespaceOf(skill);
  return namespace === undefined ? skill.name : `${namespace}/${localNameOf(skill)}`;
};

const skillUri = (app: ListedApp, skill: Skill) =>
  `${scheme}${app.slug}/${skillPath(skill)}/SKILL.md`;
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const toOptions = (app: ListedApp, skill: Skill): McpServer.SkillOptions => ({
  uri: skillUri(app, skill),
  files: Object.fromEntries(skill.files.map((file) => [encodePath(file.path), file.content])) as {
    "SKILL.md": string;
  } & Record<string, string>,
});

const safeSegment = (segment: string) =>
  segment !== "" &&
  segment !== "." &&
  segment !== ".." &&
  !segment.includes("/") &&
  !segment.includes("\\") &&
  !segment.includes("\0");

const parse = (uri: string) => {
  if (!uri.startsWith(scheme)) return undefined;
  const [slug, ...path] = uri.slice(scheme.length).split("/");
  if (slug === undefined || path.length < 2) return undefined;
  const segments = Option.liftThrowable(() => path.map(decodeURIComponent))();
  if (Option.isNone(segments)) return undefined;
  if (!Schema.is(AppSlug)(slug)) return undefined;
  if (segments.value.some((segment) => segment.includes("/"))) return undefined;
  const [first, second, ...rest] = segments.value;
  if (first === undefined || second === undefined) return undefined;
  const readings: SkillAddress[] = [];
  if (rest.length > 0) {
    const file = rest.join("/");
    if (safeSegment(first) && Schema.is(AppSkillName)(second) && Schema.is(SourceFilePath)(file))
      readings.push({
        slug,
        name: `${first}:${second}`,
        namespace: first,
        localName: second,
        file,
      });
  }
  const file = [second, ...rest].join("/");
  if (Schema.is(AppSkillName)(first) && Schema.is(SourceFilePath)(file))
    readings.push({ slug, name: first, file });
  return readings.length === 0 ? undefined : readings;
};

const matches = (skill: Skill, address: SkillAddress) =>
  address.namespace === undefined
    ? skill.name === address.name
    : (namespaceOf(skill) === address.namespace && localNameOf(skill) === address.localName) ||
      skill.name === address.name;

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
      const addresses = parse(uri);
      if (addresses === undefined) return undefined;
      const [address] = addresses;
      if (address === undefined) return undefined;
      const app = yield* appBySlug(address.slug);
      if (app === undefined) return undefined;
      const { skills } = yield* bundle(app);
      for (const reading of addresses) {
        const skill = skills.find((skill) => matches(skill, reading));
        if (skill !== undefined) return { app, skill, file: reading.file };
      }
      return undefined;
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
      (parse(uri)?.some((address) => address.file === "SKILL.md")
        ? skillAt(uri)
        : Effect.succeed(undefined)
      ).pipe(
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
