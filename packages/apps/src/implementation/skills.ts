/** Remote skill readers return complete portable bundles, never installed host files. */
import { Effect, Ref, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { skillFromFiles } from "./skill-files.ts";
import { httpProviderError } from "./provider-error.ts";
import {
  AppSkillMetadata,
  AppSkills,
  SkillFilePath,
  SkillLoadFailed,
  SkillServiceName,
  skillLoadLimits,
  type GitHubSkillsOptions,
  type WellKnownSkillsOptions,
  type SkillTransport,
} from "../contracts/skills.ts";

const failed = (reason: SkillLoadFailed["reason"]) => new SkillLoadFailed({ reason });
/** Keep only the status and whether the service reported a rate limit. */
const rejected = (status: number, headers: Readonly<Record<string, string>>) =>
  new SkillLoadFailed({
    reason:
      httpProviderError(status, headers)?.reason === "rate_limited" ? "rate_limited" : "request",
    status,
  });
/** Describe a loader failure for people, naming the service it came from. */
const describe = (service: string, { reason, status }: SkillLoadFailed) => {
  switch (reason) {
    case "rate_limited":
      return `${service} is rate limiting skill requests (HTTP ${status}).`;
    case "request":
      return status === undefined
        ? `Could not reach ${service} to load skills.`
        : `${service} returned HTTP ${status} while loading skills.`;
    case "source":
      return `The ${service} skill source settings are not valid.`;
    case "document":
      return `A skill from ${service} is not a valid skill document.`;
    case "limit":
      return `The skills from ${service} exceed Executor’s file or size limits.`;
    case "changed":
      return `The skills on ${service} changed while they were being read.`;
    case "encoding":
      return `A skill file from ${service} is not valid UTF-8 text.`;
  }
};
/** Give every failure without a message one that names the service. */
export const withService =
  (service: string | undefined) =>
  <A, R>(effect: Effect.Effect<A, SkillLoadFailed, R>) =>
    service === undefined || !Schema.is(SkillServiceName)(service)
      ? effect
      : effect.pipe(
          Effect.mapError((error) =>
            !error.message
              ? new SkillLoadFailed({
                  reason: error.reason,
                  message: describe(service, error),
                  ...(error.status === undefined ? {} : { status: error.status }),
                })
              : error,
          ),
        );
const parse = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(() => failed("document")));

const resourcePath = (path: string) => {
  if (!Schema.is(SkillFilePath)(path)) return false;
  try {
    return path.split("/").every((part) => {
      const decoded = decodeURIComponent(part);
      return (
        decoded !== "." && decoded !== ".." && !/[\\/]/.test(decoded) && !decoded.includes("\0")
      );
    });
  } catch {
    return false;
  }
};
const pathUrl = (base: string, path: string) =>
  new URL(path.split("/").map(encodeURIComponent).join("/"), base).href;

/** One loader invocation owns its byte budget and all of its network requests. */
export const reader = (transport: SkillTransport) =>
  Effect.gen(function* () {
    const bytes = yield* Ref.make(0);
    const read = (url: string) =>
      Effect.gen(function* () {
        const parsed = yield* Effect.try({
          try: () => new URL(url),
          catch: () => failed("source"),
        });
        if (
          !["https:", "http:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.hash
        )
          return yield* failed("source");
        const client = HttpClient.withScope(yield* HttpClient.HttpClient);
        const response = yield* client
          .get(parsed, {
            headers: {
              "User-Agent": "executor-skills",
              Accept: "application/json, text/plain",
              "Cache-Control": "no-cache",
            },
          })
          .pipe(Effect.mapError(() => failed("request")));
        if (response.status < 200 || response.status >= 300)
          return yield* rejected(response.status, response.headers);
        const chunks: Uint8Array[] = [];
        let size = 0;
        yield* response.stream.pipe(
          Stream.mapError(() => failed("request")),
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              size += chunk.byteLength;
              const total = yield* Ref.updateAndGet(bytes, (total) => total + chunk.byteLength);
              if (size > skillLoadLimits.fileBytes || total > skillLoadLimits.totalBytes)
                return yield* failed("limit");
              chunks.push(chunk);
            }),
          ),
        );
        const result = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(result),
          catch: () => failed("encoding"),
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provideService(FetchHttpClient.Fetch, transport.fetch ?? globalThis.fetch),
      );
    const json = (url: string) =>
      read(url).pipe(Effect.flatMap((text) => parse(Schema.fromJsonString(Schema.Unknown), text)));
    return { read, json };
  });

const Commit = Schema.Struct({ sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)) });
const Tree = Schema.Struct({
  truncated: Schema.Boolean,
  tree: Schema.Array(
    Schema.Struct({ path: Schema.String, type: Schema.String, mode: Schema.String }),
  ),
});
/** Resolve a branch once, then fetch all skill files from that exact Git commit. */
export const githubSkillsEffect = (options: GitHubSkillsOptions) =>
  Effect.gen(function* () {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo) ||
      (options.path !== undefined && !resourcePath(options.path))
    )
      return yield* failed("source");
    const remote = yield* reader(options);
    const api = `https://api.github.com/repos/${options.repo}`;
    const commit = yield* remote
      .json(`${api}/commits/${encodeURIComponent(options.ref ?? "HEAD")}`)
      .pipe(Effect.flatMap((value) => parse(Commit, value)));
    const tree = yield* remote
      .json(`${api}/git/trees/${commit.sha}?recursive=1`)
      .pipe(Effect.flatMap((value) => parse(Tree, value)));
    if (tree.truncated) return yield* failed("limit");
    const prefix = options.path === undefined ? "" : `${options.path}/`;
    const documents = tree.tree.filter(
      (entry) =>
        entry.type === "blob" &&
        entry.path.startsWith(prefix) &&
        (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")),
    );
    const resources = documents.map((document) => {
      const directory = document.path.slice(0, -"SKILL.md".length);
      return {
        directory,
        files: tree.tree.filter(
          (entry) => entry.type === "blob" && entry.path.startsWith(directory),
        ),
      };
    });
    if (resources.reduce((count, item) => count + item.files.length, 0) > skillLoadLimits.files)
      return yield* failed("limit");
    const base = `https://raw.githubusercontent.com/${options.repo}/${commit.sha}/`;
    const skills = yield* Effect.forEach(
      resources,
      ({ directory, files }) =>
        Effect.gen(function* () {
          const sources = yield* Effect.forEach(
            files,
            (file) =>
              Effect.gen(function* () {
                const path = file.path.slice(directory.length);
                if (!resourcePath(file.path) || !resourcePath(path) || file.mode === "120000")
                  return yield* failed("source");
                return { path, content: yield* remote.read(pathUrl(base, file.path)) };
              }),
            { concurrency: skillLoadLimits.concurrency },
          );
          const name = directory.slice(0, -1).split("/").at(-1);
          return yield* skillFromFiles(
            sources,
            directory === "" || name === undefined ? {} : { name },
          ).pipe(Effect.mapError(() => failed("document")));
        }),
      { concurrency: 1 },
    );
    return yield* parse(AppSkills, skills);
  }).pipe(withService("GitHub"));

const Index = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: AppSkillMetadata.fields.name,
      version: Schema.optionalKey(Schema.String),
      files: Schema.Array(Schema.String),
    }),
  ),
});
/** Fetch all indexed files and reject a publication whose index changes during the read. */
export const wellKnownSkillsEffect = (options: WellKnownSkillsOptions) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(options.url),
      catch: () => failed("source"),
    });
    if (url.pathname === "/") url.pathname = "/.well-known/agent-skills/index.json";
    else if (!url.pathname.endsWith("index.json"))
      url.pathname = `${url.pathname.replace(/\/$/, "")}/index.json`;
    const remote = yield* reader(options);
    const first = yield* remote.read(url.href);
    const index = yield* parse(Schema.fromJsonString(Index), first);
    if (
      index.skills.reduce((count, skill) => count + skill.files.length, 0) > skillLoadLimits.files
    )
      return yield* failed("limit");
    const skills = yield* Effect.forEach(
      index.skills,
      (entry) =>
        Effect.gen(function* () {
          const base = new URL(`${encodeURIComponent(entry.name)}/`, url).href;
          const files = yield* Effect.forEach(
            entry.files,
            (path) =>
              Effect.gen(function* () {
                if (!resourcePath(path)) return yield* failed("source");
                return { path, content: yield* remote.read(pathUrl(base, path)) };
              }),
            { concurrency: skillLoadLimits.concurrency },
          );
          return yield* skillFromFiles(files, { name: entry.name }).pipe(
            Effect.mapError(() => failed("document")),
          );
        }),
      { concurrency: 1 },
    );
    if ((yield* remote.read(url.href)) !== first) return yield* failed("changed");
    return yield* parse(AppSkills, skills);
  }).pipe(withService(URL.canParse(options.url) ? new URL(options.url).hostname : undefined));
