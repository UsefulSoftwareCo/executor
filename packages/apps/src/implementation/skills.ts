/** Remote skill readers return complete portable bundles, never installed host files. */
import { Effect, Ref, Schema, Stream } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/unstable/http";
import { skillFromFiles } from "./skill-files.ts";
import { wrap } from "./schema.ts";
import { httpProviderError } from "./provider-error.ts";
import { InflateLimitExceeded } from "./inflate.ts";
import {
  gitRequestHeaders,
  lsRefsRequest,
  parseLsRefs,
  parseTreeFetch,
  refCandidates,
  treeFetchRequest,
} from "./git.ts";
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
    const budget = yield* Ref.make(0);
    /** Fetch one response body within the per-file and per-load byte limits. */
    const fetchBytes = (
      url: string,
      post?: { readonly body: Uint8Array; readonly headers: Record<string, string> },
    ) =>
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
        const headers = {
          "User-Agent": "executor-skills",
          Accept: "application/json, text/plain",
          "Cache-Control": "no-cache",
        };
        const response = yield* (
          post === undefined
            ? client.get(parsed, { headers })
            : client.post(parsed, {
                headers: { ...headers, ...post.headers },
                body: HttpBody.uint8Array(post.body, post.headers["Content-Type"]),
              })
        ).pipe(Effect.mapError(() => failed("request")));
        if (response.status < 200 || response.status >= 300)
          return yield* rejected(response.status, response.headers);
        const chunks: Uint8Array[] = [];
        let size = 0;
        yield* response.stream.pipe(
          Stream.mapError(() => failed("request")),
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              size += chunk.byteLength;
              const total = yield* Ref.updateAndGet(budget, (total) => total + chunk.byteLength);
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
        return result;
      }).pipe(
        Effect.scoped,
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provideService(FetchHttpClient.Fetch, transport.fetch ?? globalThis.fetch),
      );
    const read = (url: string) =>
      fetchBytes(url).pipe(
        Effect.flatMap((result) =>
          Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(result),
            catch: () => failed("encoding"),
          }),
        ),
      );
    const json = (url: string) =>
      read(url).pipe(Effect.flatMap((text) => parse(Schema.fromJsonString(Schema.Unknown), text)));
    return { fetchBytes, read, json };
  });

type Remote = Effect.Success<ReturnType<typeof reader>>;
const unreadable = () =>
  new SkillLoadFailed({
    reason: "request",
    message: "GitHub returned a git response Executor could not read.",
  });
const git = <A>(run: () => A | Promise<A>) =>
  Effect.tryPromise({
    try: async () => run(),
    catch: (error) => (error instanceof InflateLimitExceeded ? failed("limit") : unreadable()),
  });

/**
 * Resolve a branch, tag or HEAD with git's `ls-refs`, asking only for the matching refs so large
 * repositories stay small.
 */
const resolveCommit = (remote: Remote, repo: string, ref: string | undefined) =>
  Effect.gen(function* () {
    if (ref !== undefined && /^[a-f0-9]{40}$/.test(ref)) return ref;
    const names = refCandidates(ref);
    const response = yield* remote
      .fetchBytes(`https://github.com/${repo}.git/git-upload-pack`, {
        body: lsRefsRequest(names),
        headers: gitRequestHeaders,
      })
      .pipe(
        // GitHub asks for credentials when a repository is missing or private.
        Effect.mapError((error) =>
          error.status === 401 || error.status === 404
            ? new SkillLoadFailed({
                reason: "source",
                message: `GitHub has no public repository named ${repo}.`,
                status: error.status,
              })
            : error,
        ),
      );
    const refs = yield* git(() => parseLsRefs(response));
    const commit = names.map((name) => refs.get(name)).find((sha) => sha !== undefined);
    if (commit === undefined)
      return yield* new SkillLoadFailed({
        reason: "source",
        message: `GitHub repository ${repo} has no branch or tag named ${ref}.`,
      });
    return commit;
  });

/** List files at a commit from a shallow git fetch of its trees, without file contents. */
const listFiles = (remote: Remote, repo: string, commit: string, path: string | undefined) =>
  remote
    .fetchBytes(`https://github.com/${repo}.git/git-upload-pack`, {
      body: treeFetchRequest(commit),
      headers: gitRequestHeaders,
    })
    .pipe(
      Effect.flatMap((response) =>
        git(() =>
          parseTreeFetch(response, commit, path, { objectBytes: skillLoadLimits.fileBytes }),
        ),
      ),
    );

/**
 * Resolve a ref once, then fetch all skill files from that exact commit. No request uses the
 * REST API, whose unauthenticated budget is shared by every client on the same IP address.
 */
const SkillDirectories = Schema.Array(
  Schema.Struct({
    directory: Schema.String,
    files: Schema.Array(Schema.Struct({ path: Schema.String, mode: Schema.String })),
  }),
);
type SkillDirectories = typeof SkillDirectories.Type;

/** Group the files at a commit by skill directory, within the file limit. */
const skillDirectories = (
  remote: Remote,
  repo: string,
  commit: string,
  path: string | undefined,
): Effect.Effect<SkillDirectories, SkillLoadFailed> =>
  Effect.gen(function* () {
    const files = yield* listFiles(remote, repo, commit, path);
    const documents = files.filter(
      (file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"),
    );
    const directories = documents.map((document) => {
      const directory = document.path.slice(0, -"SKILL.md".length);
      return { directory, files: files.filter((file) => file.path.startsWith(directory)) };
    });
    if (directories.reduce((count, item) => count + item.files.length, 0) > skillLoadLimits.files)
      return yield* failed("limit");
    return directories;
  });

/**
 * Reuse a commit's skill file list from the app cache. The list is small and never changes for a
 * commit, so the entry stays fresh for the longest retention the cache allows.
 */
const cachedSkillDirectories = (
  cache: NonNullable<GitHubSkillsOptions["cache"]>,
  repo: string,
  commit: string,
  path: string | undefined,
) =>
  Effect.tryPromise({
    try: () =>
      cache.get({
        key: ["apps/githubSkills/directories", 1, repo, commit, path ?? null],
        schema: wrap(SkillDirectories, false),
        freshFor: "7 days",
        load: (context) =>
          Effect.runPromise(
            reader(context).pipe(
              Effect.flatMap((remote) => skillDirectories(remote, repo, commit, path)),
            ),
            { signal: context.signal },
          ),
      }),
    catch: (error) =>
      Schema.is(SkillLoadFailed)(error)
        ? error
        : new SkillLoadFailed({
            reason: "request",
            message: "Executor could not read or update the app cache for skills.",
          }),
  });

export const githubSkillsEffect = (options: GitHubSkillsOptions) =>
  Effect.gen(function* () {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo) ||
      (options.path !== undefined && !resourcePath(options.path))
    )
      return yield* failed("source");
    const remote = yield* reader(options);
    const commit = yield* resolveCommit(remote, options.repo, options.ref);
    const resources = yield* options.cache === undefined
      ? skillDirectories(remote, options.repo, commit, options.path)
      : cachedSkillDirectories(options.cache, options.repo, commit, options.path);
    const base = `https://raw.githubusercontent.com/${options.repo}/${commit}/`;
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
