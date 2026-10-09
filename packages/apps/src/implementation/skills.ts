/** Remote skill readers return complete portable bundles, never installed host files. */
import { Effect, Ref, Schema, Stream } from "effect";
import { Base64, Hex } from "effect/encoding";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";
import { skillFromFiles } from "./skill-files.ts";
import { wrap } from "./schema.ts";
import { fromPromise, method, toPromise } from "./authoring.ts";
import { accountProviderError, httpProviderError } from "./provider-error.ts";
import { InflateLimitExceeded } from "./inflate.ts";
import { failOnNetworkRefusal } from "./network.ts";
import {
  gitRequestHeaders,
  lsRefsRequest,
  parseLsRefs,
  parseTreeFetch,
  refCandidates,
  treeFetchRequest,
} from "./git.ts";
import { catalogCache, catalogScope, type CatalogScopeProblem } from "./catalog-cache.ts";
import type { AppCache, CacheLoadContext } from "../contracts/cache.ts";
import type { JsonValue } from "../contracts/schema.ts";
import { NetworkRefused, networkRefusalStatus } from "../contracts/network.ts";
import { ProviderError } from "../contracts/provider-error.ts";
import {
  AppSkillMetadata,
  AppSkillSource,
  AppSkills,
  SkillFilePath,
  SkillLoadFailed,
  SkillServiceName,
  skillLoadLimits,
  type GitHubSkillsOptions,
  type SkillCacheOptions,
  type WellKnownSkillsOptions,
  type SkillTransport,
} from "../contracts/skills.ts";

const failed = (reason: SkillLoadFailed["reason"]) => new SkillLoadFailed({ reason });
/** Keep only the status the request returned and whether it reported a rate limit. */
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
  <A, R>(effect: Effect.Effect<A, SkillLoadFailed | NetworkRefused, R>) =>
    service === undefined || !Schema.is(SkillServiceName)(service)
      ? effect
      : effect.pipe(
          Effect.mapError((error) =>
            Schema.is(SkillLoadFailed)(error) && !error.message
              ? new SkillLoadFailed({
                  reason: error.reason,
                  message: describe(service, error),
                  ...(error.status === undefined ? {} : { status: error.status }),
                  ...(error.missing === undefined ? {} : { missing: error.missing }),
                })
              : error,
          ),
        );
/** Keep network refusals and the loader's own failures; anything else did not load. */
const loaderFailure = (error: unknown, otherwise: () => SkillLoadFailed) =>
  Schema.is(SkillLoadFailed)(error) || Schema.is(NetworkRefused)(error) ? error : otherwise();
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

interface ReadRequest {
  readonly headers?: Readonly<Record<string, string>>;
  /** Describe a refusal by Executor's app network; defaults to the refusal itself. */
  readonly refused?: (refused: NetworkRefused) => SkillLoadFailed | NetworkRefused;
}

/** One loader invocation owns its byte budget and all of its network requests. */
export const reader = (transport: SkillTransport) =>
  Effect.gen(function* () {
    const budget = yield* Ref.make(0);
    /** Fetch one response body within the per-file and per-load byte limits. */
    const fetchBytes = (url: string, request: ReadRequest & { readonly body?: Uint8Array } = {}) =>
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
        const refusal = request.refused ?? ((refused: NetworkRefused) => refused);
        const client = HttpClient.withScope(yield* HttpClient.HttpClient);
        const headers = {
          "User-Agent": "executor-skills",
          Accept: "application/json, text/plain",
          "Cache-Control": "no-cache",
          ...request.headers,
        };
        const response = yield* (
          request.body === undefined
            ? client.get(parsed, { headers })
            : client.post(parsed, {
                headers,
                body: HttpBody.uint8Array(request.body, request.headers?.["Content-Type"]),
              })
        ).pipe(
          // `ctx.fetch` rejects with a network refusal; any other failed request got no answer.
          Effect.mapError((error) =>
            Schema.is(NetworkRefused)(error.cause) ? refusal(error.cause) : failed("request"),
          ),
        );
        // A response marked as a network refusal fails as one, whatever its status.
        yield* failOnNetworkRefusal(response).pipe(Effect.mapError(refusal));
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
    const read = (url: string, request: ReadRequest = {}) =>
      fetchBytes(url, request).pipe(
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
  // oxlint-disable-next-line executor/authored-code-through-adapter -- this module's git parsing
  Effect.tryPromise({
    try: async () => run(),
    catch: (error) => (error instanceof InflateLimitExceeded ? failed("limit") : unreadable()),
  });

/** The hosts a GitHub read sends its token to; its provider must allow both. */
const githubHosts = ["github.com", "raw.githubusercontent.com"] as const;

/**
 * One read's requests to a repository, carrying the token on each when one is given. Git's smart
 * HTTP takes it as a Basic password and raw file reads as a token, so a handle in either is
 * replaced with the value only on requests to the provider's hosts.
 */
const githubRequests = (remote: Remote, repo: string, token: string | undefined) => {
  // The loader names the host it requested, which the app's fetch may have redirected.
  const refused = (host: string) => (refusal: NetworkRefused) =>
    refusal.refusal.reason === "credential_host"
      ? new SkillLoadFailed({
          reason: "source",
          status: networkRefusalStatus,
          message: `A request with the GitHub token to ${host} was refused because the account's provider does not declare that host. The provider must declare hosts ${githubHosts.join(" and ")}; reconnect an account connected with other hosts.`,
        })
      : refusal;
  const upload = (body: Uint8Array) =>
    remote.fetchBytes(`https://${githubHosts[0]}/${repo}.git/git-upload-pack`, {
      body,
      headers: {
        ...gitRequestHeaders,
        ...(token === undefined
          ? {}
          : { Authorization: `Basic ${Base64.encode(`x-access-token:${token}`)}` }),
      },
      refused: refused(githubHosts[0]),
    });
  const file = (commit: string, path: string) =>
    remote.read(pathUrl(`https://${githubHosts[1]}/${repo}/${commit}/`, path), {
      ...(token === undefined ? {} : { headers: { Authorization: `token ${token}` } }),
      refused: refused(githubHosts[1]),
    });
  return { repo, authenticated: token !== undefined, upload, file };
};
type GitHub = ReturnType<typeof githubRequests>;

/**
 * Resolve a branch, tag or HEAD with git's `ls-refs`, asking only for the matching refs so large
 * repositories stay small.
 */
const resolveCommit = (github: GitHub, ref: string | undefined) =>
  Effect.gen(function* () {
    const { repo } = github;
    if (ref !== undefined && /^[a-f0-9]{40}$/.test(ref)) return ref;
    const names = refCandidates(ref);
    const response = yield* github.upload(lsRefsRequest(names)).pipe(
      Effect.mapError((error) => {
        if (!Schema.is(SkillLoadFailed)(error) || error.reason !== "request") return error;
        // Without credentials GitHub asks for them when a repository is missing or private. The
        // status reached the app's code, which may have replaced the fetch, so the repository is
        // not claimed missing.
        if (!github.authenticated && (error.status === 404 || error.status === 401))
          return new SkillLoadFailed({
            reason: "source",
            message: `Reading GitHub repository ${repo} without credentials returned HTTP ${error.status}: it may not exist, or it may be private. To read a private repository, pass a GitHub account and its token.`,
            status: error.status,
            missing: "repository",
          });
        // With them, GitHub answers 404 for a repository the token cannot read as for one that
        // does not exist, and the token is Executor's to send, so neither is claimed.
        if (github.authenticated && error.status === 404)
          return new SkillLoadFailed({
            reason: "request",
            message: `GitHub repository ${repo} is not available with the account's token (HTTP 404). Check the repository name and that the token can read it.`,
            status: error.status,
          });
        return error;
      }),
    );
    const refs = yield* git(() => parseLsRefs(response));
    const commit = names.map((name) => refs.get(name)).find((sha) => sha !== undefined);
    // The refs read from the repository include none with this name.
    if (commit === undefined)
      return yield* new SkillLoadFailed({
        reason: "source",
        message: `The refs read from GitHub repository ${repo} include no branch or tag named ${ref}.`,
        missing: "ref",
      });
    return commit;
  });

/** List files at a commit from a shallow git fetch of its trees, without file contents. */
const listFiles = (github: GitHub, commit: string, path: string | undefined) =>
  github
    .upload(treeFetchRequest(commit))
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
  github: GitHub,
  commit: string,
  path: string | undefined,
): Effect.Effect<SkillDirectories, SkillLoadFailed | NetworkRefused> =>
  Effect.gen(function* () {
    const files = yield* listFiles(github, commit, path);
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
  cache: AppCache,
  transport: SkillTransport,
  options: GitHubSkillsOptions,
  commit: string,
) =>
  fromPromise(
    method(cache, "get"),
    "cache",
  )<typeof SkillDirectories.Type>({
    key: ["apps/githubSkills/directories", 1, options.repo, commit, options.path ?? null],
    schema: wrap(SkillDirectories, false),
    freshFor: "7 days",
    // Executor's own loader: the app's cache runs it natively, so only its requests are upstream.
    load: toPromise(
      (context: CacheLoadContext) =>
        // Keep the author's fetch and this read's token, as every other request in it does.
        reader({ fetch: transport.fetch, signal: context.signal }).pipe(
          Effect.flatMap((remote) =>
            skillDirectories(
              githubRequests(remote, options.repo, options.token),
              commit,
              options.path,
            ),
          ),
        ),
      // A cache may call the loader as a Promise; its own signal cancels that load.
      (context) => context.signal,
    ),
  }).pipe(
    Effect.mapError((error) =>
      loaderFailure(
        error,
        () =>
          new SkillLoadFailed({
            reason: "request",
            message: "Executor could not read or update the app cache for skills.",
          }),
      ),
    ),
  );

/**
 * What one request says about a source's current publication, and how to load its skills. Equal
 * `id`s have equal skills, so a kept catalog with the same `id` is still current. A source that
 * cannot tell from that request has no `id`.
 */
interface Publication {
  readonly id: string | undefined;
  readonly load: Effect.Effect<typeof AppSkills.Type, SkillLoadFailed | NetworkRefused>;
}
/** Hex SHA-256 of a value's JSON. */
const digest = (value: unknown) =>
  // oxlint-disable-next-line executor/authored-code-through-adapter -- Web Crypto
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
  ).pipe(Effect.map((bytes) => Hex.encode(new Uint8Array(bytes))));
/** The one request that checks a publication, bounded so a slow source fails the read promptly. */
const checked = <A, E>(request: Effect.Effect<A, E>) =>
  request.pipe(
    Effect.timeoutOrElse({
      duration: skillLoadLimits.checkMillis,
      orElse: () => Effect.fail(failed("request")),
    }),
  );

/**
 * Keep a loaded catalog in the app cache, paged like an MCP tool catalog. Past `freshFor` it is
 * never served unchecked: the read awaits one request for the source's publication and loads the
 * source again only when that changed, so a read never answers with a catalog that a background
 * refresh replaces moments later. A failed check fails the read; the kept catalog stays for the
 * next one. The check keeps the author's fetch and uses the cache's signal.
 */
const cachedCatalog = (
  options: SkillCacheOptions & SkillTransport,
  prefix: readonly JsonValue[],
  publication: (
    transport: SkillTransport,
    cache: AppCache | undefined,
  ) => Effect.Effect<Publication, SkillLoadFailed | NetworkRefused>,
) =>
  options.cache === undefined
    ? publication(options, undefined).pipe(Effect.flatMap((source) => source.load))
    : catalogCache({
        cache: options.cache,
        ...(options.freshFor === undefined ? {} : { freshFor: options.freshFor }),
        ...(options.staleFor === undefined ? {} : { staleFor: options.staleFor }),
        stale: "revalidate",
        prefix,
        schema: AppSkillSource,
        summary: { schema: AppSkillMetadata, of: ({ files: _files, ...metadata }) => metadata },
        load: (context, kept) =>
          Effect.gen(function* () {
            const source = yield* context === undefined
              ? publication(options, options.cache)
              : publication({ fetch: options.fetch, signal: context.signal }, context.cache);
            if (source.id === undefined) return { tools: yield* source.load };
            const previous = kept === undefined ? undefined : yield* kept;
            const tools =
              previous?.header?.["publication"] === source.id
                ? yield* previous.tools
                : yield* source.load;
            return { tools, header: { publication: source.id } };
          }),
      }).pipe(
        Effect.flatMap((catalog) => catalog.list()),
        Effect.mapError((error) =>
          loaderFailure(
            error,
            () =>
              new SkillLoadFailed({
                reason: "request",
                message: "Executor could not read or update the app cache for skills.",
              }),
          ),
        ),
      );

/** A token is a header value: visible ASCII, as GitHub tokens and Executor's handles are. */
const GitHubToken = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]+$/u));

const scopeMessages = {
  "missing-account": "A GitHub token needs its account. Pass account: ctx.accounts.<slot> with it.",
  "unselected-account": "The GitHub account is not one of this app's selected accounts.",
} satisfies Record<CatalogScopeProblem, string>;

/**
 * The cache a catalog lives in. A private catalog stays in its account's scope, as MCP and GraphQL
 * catalogs do, so another account never reads it. The token never enters a key.
 */
const githubCache = (options: GitHubSkillsOptions) =>
  options.account !== undefined && !Schema.is(GitHubToken)(options.token)
    ? Effect.fail(
        new SkillLoadFailed({
          reason: "source",
          message: "The GitHub account was passed without a valid token.",
        }),
      )
    : catalogScope(
        options,
        options.token,
        (problem) => new SkillLoadFailed({ reason: "source", message: scopeMessages[problem] }),
      );

/** GitHub rejected the account's token or refused its request; name the account. */
const attributed =
  (account: { readonly id: string } | undefined) =>
  (error: SkillLoadFailed | NetworkRefused): SkillLoadFailed | NetworkRefused | ProviderError =>
    account !== undefined &&
    Schema.is(SkillLoadFailed)(error) &&
    error.reason === "request" &&
    (error.status === 401 || error.status === 403)
      ? accountProviderError(
          new ProviderError({
            reason: error.status === 401 ? "unauthorized" : "rejected",
            status: error.status,
          }),
          account.id,
        )
      : error;

export const githubSkillsEffect = (
  options: GitHubSkillsOptions,
): Effect.Effect<typeof AppSkills.Type, SkillLoadFailed | NetworkRefused | ProviderError> =>
  Effect.gen(function* () {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo) ||
      (options.path !== undefined && !resourcePath(options.path))
    )
      return yield* failed("source");
    const cache = yield* githubCache(options);
    return yield* cachedCatalog(
      cache === undefined ? options : { ...options, cache },
      ["apps/githubSkills/catalog", 1, options.repo, options.ref ?? null, options.path ?? null],
      (transport, cache) => githubPublication(options, transport, cache),
    );
  }).pipe(withService("GitHub"), Effect.mapError(attributed(options.account)));

/** A branch or tag resolves to its commit with one request; the commit identifies the files. */
const githubPublication = (
  options: GitHubSkillsOptions,
  transport: SkillTransport,
  cache: AppCache | undefined,
) =>
  Effect.gen(function* () {
    const github = githubRequests(yield* reader(transport), options.repo, options.token);
    const commit = yield* checked(resolveCommit(github, options.ref));
    return {
      id: commit,
      load: githubCatalog(options, github, commit, transport, cache),
    } satisfies Publication;
  });

const githubCatalog = (
  options: GitHubSkillsOptions,
  github: GitHub,
  commit: string,
  transport: SkillTransport,
  cache: AppCache | undefined,
) =>
  Effect.gen(function* () {
    const resources = yield* cache === undefined
      ? skillDirectories(github, commit, options.path)
      : cachedSkillDirectories(cache, transport, options, commit);
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
                return { path, content: yield* github.file(commit, file.path) };
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
  });

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
    return yield* cachedCatalog(
      options,
      ["apps/wellKnownSkills/catalog", 1, url.href],
      (transport) => wellKnownPublication(url, transport),
    );
  }).pipe(withService(URL.canParse(options.url) ? new URL(options.url).hostname : undefined));

/**
 * Read the index once. Publishers change an entry's `version` whenever its files change, so an
 * index whose every entry has one identifies its publication. Without versions only the files can
 * show a change, and every check loads them.
 */
const wellKnownPublication = (url: URL, transport: SkillTransport) =>
  Effect.gen(function* () {
    const remote = yield* reader(transport);
    const first = yield* checked(remote.read(url.href));
    const index = yield* parse(Schema.fromJsonString(Index), first);
    const id = index.skills.every((skill) => skill.version !== undefined)
      ? yield* digest(index.skills.map(({ name, version, files }) => [name, version, files]))
      : undefined;
    return { id, load: wellKnownCatalog(url, remote, first, index) } satisfies Publication;
  });

const wellKnownCatalog = (url: URL, remote: Remote, first: string, index: typeof Index.Type) =>
  Effect.gen(function* () {
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
  });
