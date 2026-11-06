/** Apps CLI and standard Git credential helper, sharing the product's app APIs. */
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Option,
  Path,
  Redacted,
  Schema,
  SchemaAST,
  Stdio,
  Stream,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { isPlatformError } from "effect/PlatformError";
import {
  AppId,
  AppName,
  AppSkillCatalog,
  AppSkillDocument,
  AppSkillName,
  CommittedSource,
  ExecutorApi,
  SourceCommit,
  SourceFilePath,
  SourceError,
  inlineBytes,
  PackageName,
  hostedExecutorOrigin,
  publicFileLimits,
  sourceLimits,
  wireRevision,
  wireRevisionHeader,
  type App,
} from "@executor-js/sdk/core";
import { GitPushRefused, readCommitBlobs } from "@executor-js/app-source/git-client";
import {
  codeOnly,
  fitsRequest,
  formatBytes,
  formatCount,
  ignoredSource,
  pushSource,
  readSource,
  requestFiles,
  type LocalFile,
} from "./implementation/cli-source.ts";
import { checkCommand } from "./implementation/cli-check.ts";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import {
  AppClientError,
  HostRecovery,
  HostRequestFailed,
  LoginFailed,
  SourceRejected,
} from "./client-error.ts";
import {
  AppAccess,
  AppAccessDenied,
  AppOperationError,
  appManagementApi,
  appOperationErrors,
} from "./contracts/api.ts";
import { frameworkApi } from "./contracts/framework.ts";
import {
  RegistryOrigin,
  gitSession,
  registryLogin,
  registrySession,
  sessionRefreshMarginMs,
} from "./implementation/node-auth.ts";

/** Skill lookups report the host's failure tag or the missing option; never a response body. */
class SkillLookupFailed extends Schema.TaggedError<SkillLookupFailed>()("SkillLookupFailed", {
  reason: Schema.String,
}) {}
const host = Flag.String("host").pipe(
  Flag.withDescription(
    `Executor origin. Defaults to EXECUTOR_HOST, then the local background Executor, which starts if needed; use ${hostedExecutorOrigin} for hosted Executor`,
  ),
  Flag.withFallbackConfig(Config.String("EXECUTOR_HOST")),
  Flag.optional,
);
const organization = Flag.String("organization").pipe(
  Flag.withDescription(
    "Hosted organization. Required with EXECUTOR_ACCESS_TOKEN; after executor apps login it defaults to the signed-in organization",
  ),
  Flag.optional,
);
const connection = { host, organization };
const app = Flag.String("app").pipe(
  Flag.withSchema(AppId),
  Flag.withDescription("App ID, such as app_…; executor apps list prints each app's id"),
);
const name = Flag.String("name").pipe(
  Flag.withSchema(AppName),
  Flag.withDescription("Name for the new app"),
);
const commit = (purpose: string) =>
  Flag.String("commit").pipe(
    Flag.withSchema(SourceCommit),
    Flag.withDescription(`Full 40-character Git commit ${purpose}`),
  );
const files = Flag.Path("files", { pathType: "either", mustExist: true }).pipe(
  Flag.withDescription(
    `Complete app source: a directory read recursively (skipping ${ignoredSource.join(", ")}), or a JSON file containing [{"path": "index.ts", "content": "..."}]. It must include a root index.ts. Code outside ui/public/ is UTF-8 text, at most ${formatCount(sourceLimits.files)} files and ${formatBytes(sourceLimits.bytes)}. Files under ui/public/ may be binary: at most ${formatCount(publicFileLimits.files)} files, each at most ${formatCount(publicFileLimits.fileBytes)} bytes. A source larger than ${formatBytes(sourceLimits.bytes)} in total is pushed with Git. The CLI checks this before uploading`,
  ),
);
const publication = {
  package: Flag.String("package").pipe(
    Flag.withSchema(PackageName),
    Flag.withDescription("Published package name, for example @owner.executor.community/app"),
  ),
  commit: commit("of the published version to install"),
};
/** The local Executor that commands use when neither --host nor EXECUTOR_HOST names a host. */
export interface LocalServer {
  readonly url: string;
  /** Sent as the local API key. */
  readonly token: Redacted.Redacted<string>;
}
/**
 * The local Executor could not be started or reached for a command without --host or
 * EXECUTOR_HOST. `message` is the local server's own explanation and what to do about it.
 */
export class LocalServerUnavailable extends Schema.TaggedError<LocalServerUnavailable>()(
  "LocalServerUnavailable",
  { message: Schema.String },
) {}
/**
 * The host one command talks to: the --host or EXECUTOR_HOST origin, or the local server with the
 * token its resolver supplied. A named host resolves its credential for each request, as a hosted
 * session can refresh during a long command.
 */
interface Host {
  readonly origin: string;
  readonly local?: Redacted.Redacted<string>;
}
/** Resolve the credential and, for hosted Executor, the organization every request targets. */
const access = ({ origin: host, local: localToken }: Host, organization: Option.Option<string>) =>
  Effect.gen(function* () {
    if (localToken !== undefined) {
      // The local server has no organizations; a hosted one must be named with --host.
      if (Option.isSome(organization))
        return yield* new AppClientError({ reason: "authentication" });
      return { token: localToken, organization: undefined };
    }
    yield* Schema.decodeUnknownEffect(RegistryOrigin)(host).pipe(
      Effect.mapError(() => new AppClientError({ reason: "authentication" })),
    );
    const token = yield* Config.Redacted("EXECUTOR_ACCESS_TOKEN").pipe(Config.option);
    if (Option.isSome(token)) {
      if (Option.isNone(organization))
        return yield* new AppClientError({ reason: "authentication" });
      return { token: token.value, organization: organization.value };
    }
    const local = yield* Config.Redacted("EXECUTOR_API_KEY").pipe(Config.option);
    if (
      Option.isSome(local) &&
      Option.isNone(organization) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(new URL(host).hostname)
    )
      return { token: local.value, organization: undefined };
    const session = Redacted.value(yield* registrySession(host));
    if (Option.isSome(organization) && organization.value !== session.organization)
      return yield* new AppClientError({ reason: "forbidden" });
    return { token: Redacted.make(session.accessToken), organization: session.organization };
  });
/** Authenticated requests to the host; redirects are refused so credentials never follow them. */
const transport = (host: string, token: Redacted.Redacted<string>, path = (url: string) => url) =>
  Effect.map(HttpClient.HttpClient, (client) =>
    client.pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.updateUrl((url) => host + path(url)),
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeader(wireRevisionHeader, String(wireRevision)),
        ),
      ),
      HttpClient.transform((response) =>
        Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "error" }),
      ),
    ),
  ).pipe(Effect.provide(FetchHttpClient.layer));
/** An Executor API error body this CLI's contract does not declare, as every Executor host writes it. */
const HostAnswer = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    recovery: Schema.optional(HostRecovery),
  }),
);
/** Read a host's own JSON error from a bounded body; any other response text is never kept. */
const hostAnswer = (response: HttpClientResponse.HttpClientResponse) =>
  /^application\/(?:[\w.-]+\+)?json$/i.test(
    response.headers["content-type"]?.split(";")[0]?.trim() ?? "",
  ) && Number(response.headers["content-length"] ?? 0) <= 65_536
    ? response.text.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(HostAnswer)),
        Effect.map(({ _tag, message, recovery }) => ({
          code: _tag,
          message,
          ...(recovery === undefined ? {} : { recovery }),
        })),
        Effect.option,
      )
    : Effect.succeedNone;
/**
 * A response outside the operation's contract keeps its method, path, status and any Executor
 * error the body states, so the command can say what the host answered. Credentials and other
 * response text are never kept.
 */
const hostFailure = (error: HttpClientError.HttpClientError | Schema.SchemaError) =>
  Effect.gen(function* () {
    if (!HttpClientError.isHttpClientError(error))
      return new HostRequestFailed({ reason: "response" });
    const request = {
      method: error.request.method,
      ...(URL.canParse(error.request.url) ? { path: new URL(error.request.url).pathname } : {}),
    };
    const response = error.response;
    if (response === undefined) return new HostRequestFailed({ reason: "network", ...request });
    if (response.status === 401) return new AppClientError({ reason: "authentication" });
    const answer = yield* hostAnswer(response);
    if (response.status === 403 && Option.isNone(answer))
      return new AppClientError({ reason: "forbidden" });
    return new HostRequestFailed({
      reason: response.status < 400 ? "response" : "status",
      ...request,
      status: response.status,
      ...(Option.isSome(answer) ? { answer: answer.value } : {}),
    });
  }).pipe(Effect.flatMap(Effect.fail));
const isTransportFailure = (
  error: unknown,
): error is HttpClientError.HttpClientError | Schema.SchemaError =>
  HttpClientError.isHttpClientError(error) || Schema.isSchemaError(error);
const localManagementApi = appManagementApi("/api", AppAccess);
const hostedManagementApi = appManagementApi("/api/organizations/:organization", AppAccess);
const localFrameworkApi = frameworkApi("/api", AppAccess);
const hostedFrameworkApi = frameworkApi("/api/organizations/:organization", AppAccess);
/** Both hosts serve one app management contract; hosted routes add the organization. */
type Management = HttpApiClient.ForApi<typeof localManagementApi>["appManagement"];
type Framework = HttpApiClient.ForApi<typeof localFrameworkApi>["framework"];
/**
 * Typed clients for one host. App management uses its shared contract. Skill reads use the SDK
 * routes: local serves them under /v1, and hosted serves the same endpoints and
 * schemas under its organization prefix.
 */
const connect = (host: Host, organization: Option.Option<string>) =>
  Effect.gen(function* () {
    const target = yield* access(host, organization);
    const httpClient = yield* transport(host.origin, target.token);
    if (target.organization === undefined) {
      const client = yield* HttpApiClient.makeWith(localManagementApi, { httpClient });
      const management: Management = client.appManagement;
      const framework: Framework = (yield* HttpApiClient.makeWith(localFrameworkApi, {
        httpClient,
      })).framework;
      return {
        management,
        framework,
        tenant: {},
        skills: yield* HttpApiClient.group(ExecutorApi, { group: "skills", httpClient }),
      };
    }
    const prefix = `/api/organizations/${encodeURIComponent(target.organization)}`;
    const sdkClient = yield* transport(host.origin, target.token, (url) =>
      url.replace(/^\/v1\//, `${prefix}/`),
    );
    const client = yield* HttpApiClient.makeWith(hostedManagementApi, { httpClient });
    const management: Management = client.appManagement;
    const framework: Framework = (yield* HttpApiClient.makeWith(hostedFrameworkApi, { httpClient }))
      .framework;
    return {
      management,
      framework,
      tenant: { organization: target.organization },
      skills: yield* HttpApiClient.group(ExecutorApi, { group: "skills", httpClient: sdkClient }),
    };
  });
/** Run one app management operation; contract errors stay typed for command diagnostics. */
const manage = <A, E>(
  host: Host,
  organization: Option.Option<string>,
  operation: (
    api: Management,
    tenant: { readonly organization?: string },
  ) => Effect.Effect<A, E | HttpClientError.HttpClientError | Schema.SchemaError>,
) =>
  connect(host, organization).pipe(
    Effect.flatMap(({ management, tenant }) => operation(management, tenant)),
    Effect.catchIf(isTransportFailure, hostFailure),
  );
/** Print a validated response exactly as the host sent it. */
const printResponse = <A>([, response]: readonly [A, HttpClientResponse.HttpClientResponse]) =>
  response.json.pipe(Effect.flatMap((json) => Console.log(JSON.stringify(json, null, 2))));
/** Print a value the CLI assembled from host responses, in its wire form. */
const print =
  <S extends Schema.Top & { readonly EncodingServices: never }>(schema: S) =>
  (value: S["Type"]) =>
    Schema.encodeEffect(Schema.toCodecJson(schema))(value).pipe(
      Effect.flatMap((json) => Console.log(JSON.stringify(json, null, 2))),
    );
/** The working source the host holds now, with its revision and Git location. */
const workingSource = (host: Host, organization: Option.Option<string>, app: AppId) =>
  manage(host, organization, (api, tenant) => api.source({ params: { ...tenant, app } }));

/** The credential Git requests carry, the same one the API requests use. */
const gitAuthorization = (host: Host, organization: Option.Option<string>) =>
  access(host, organization).pipe(Effect.map(({ token }) => `Bearer ${Redacted.value(token)}`));

/**
 * Save a local source as the commit after `expected`. A source that fits one request is sent as
 * files; a larger one is pushed with Git, sending only the files the app does not already hold.
 */
const saveSource = (input: {
  readonly host: Host;
  readonly organization: Option.Option<string>;
  readonly app: AppId;
  readonly expected: typeof SourceCommit.Type;
  readonly files: ReadonlyArray<LocalFile>;
  readonly message: string;
}) =>
  Effect.gen(function* () {
    if (fitsRequest(input.files)) {
      const files = yield* requestFiles(input.files);
      return yield* manage(input.host, input.organization, (api, tenant) =>
        api.commit({
          params: { ...tenant, app: input.app },
          payload: { expected: input.expected, files, message: input.message },
        }),
      );
    }
    const source = yield* workingSource(input.host, input.organization, input.app);
    if (source.revision.commit !== input.expected)
      return yield* new GitPushRefused({
        reason: "conflict",
        detail: `the app's working source is at ${source.revision.commit}, not ${input.expected}`,
      });
    const pushed = yield* pushSource({
      url: source.gitUrl,
      authorization: yield* gitAuthorization(input.host, input.organization),
      expected: input.expected,
      remote: source.files,
      files: input.files,
      message: input.message,
    });
    return CommittedSource.make({
      revision: { code: source.revision.code, commit: pushed.commit },
      removed: pushed.removed,
    });
  });

/** Skill lookups print the host's result for all deployed apps, one catalog, or one document. */
const SkillListing = Schema.Struct({
  catalogs: Schema.Array(AppSkillCatalog),
  unavailable: Schema.Array(Schema.String),
});
/** A skill read the host rejects keeps the host's typed error; other answers keep their status. */
const skillRead = <A, E>(
  effect: Effect.Effect<A, E | HttpClientError.HttpClientError | Schema.SchemaError>,
) => effect.pipe(Effect.catchIf(isTransportFailure, hostFailure));
/** Skills come from each app's version on the host; the CLI bundles no guidance. */
const readSkills = (args: {
  readonly host: Host;
  readonly organization: Option.Option<string>;
  readonly app: Option.Option<string>;
  readonly name: Option.Option<typeof AppSkillName.Type>;
  readonly file: Option.Option<typeof SourceFilePath.Type>;
}) =>
  Effect.gen(function* () {
    if (Option.isNone(args.name) && Option.isSome(args.file))
      return yield* new SkillLookupFailed({ reason: "Pass --name with --file." });
    if (Option.isNone(args.app) && Option.isSome(args.name))
      return yield* new SkillLookupFailed({ reason: "Pass --app with --name." });
    const { management, tenant, skills } = yield* connect(args.host, args.organization);
    const apps = yield* management
      .list({ params: tenant })
      .pipe(Effect.catchIf(isTransportFailure, hostFailure));
    // The host resolves the accounts you linked to each app, as the MCP skills tool does.
    const catalog = (app: App) => skillRead(skills.list({ params: { app: app.id }, query: {} }));
    if (Option.isNone(args.app)) {
      const results = yield* Effect.forEach(
        apps.filter((app) => app.activeVersion !== null),
        (app) =>
          catalog(app).pipe(
            Effect.map((found) => ({ app: app.slug, catalogs: [found] })),
            Effect.catch(() => Effect.succeed({ app: app.slug, catalogs: undefined })),
          ),
        { concurrency: 4 },
      );
      return yield* print(SkillListing)({
        catalogs: results.flatMap((entry) => entry.catalogs ?? []),
        unavailable: results.flatMap((entry) => (entry.catalogs === undefined ? [entry.app] : [])),
      });
    }
    const slug = args.app.value;
    const selected = apps.find((app) => app.slug === slug || app.id === slug);
    if (selected === undefined)
      return yield* new SkillLookupFailed({
        reason: `No visible app has slug or ID ${slug}. Run executor apps list to see apps.`,
      });
    if (Option.isNone(args.name))
      return yield* catalog(selected).pipe(Effect.flatMap(print(AppSkillCatalog)));
    return yield* skillRead(
      skills.read({
        params: { app: selected.id, name: args.name.value },
        query: { file: Option.getOrUndefined(args.file) },
      }),
    ).pipe(Effect.flatMap(print(AppSkillDocument)));
  });

const notSignedIn = `Not signed in to this host. For hosted Executor, run executor apps login --host ${hostedExecutorOrigin} and pass the same --host to each command, or set EXECUTOR_HOST. Without --host or EXECUTOR_HOST, commands use the local background Executor; for a local server at --host, set EXECUTOR_API_KEY to its API key.`;
/** What each sign-in failure means and what to do next. */
const loginFailure: Record<LoginFailed["reason"], string> = {
  host: `Could not read this host's sign-in settings. Check --host, for example --host ${hostedExecutorOrigin}, and your network connection.`,
  unsupported:
    "This host does not support signing in from the CLI. Update it to a release with device sign-in.",
  registration: "The host did not start a sign-in for the CLI. Try again in a moment.",
  denied: "Sign-in was cancelled or denied in the browser. Run executor apps login to try again.",
  expired:
    "Sign-in was not approved in time. Run executor apps login again and approve it within 10 minutes.",
  token: "The host did not complete the approved sign-in. Run executor apps login to try again.",
  context:
    "Signed in, but the host did not return your organization. Check that your account belongs to an organization, then sign in again.",
  storage:
    "Signed in, but the session could not be saved in the system credential store or in ~/.local/state/executor/auth. Check that this directory is writable.",
};

/**
 * A failed command, as agents read it: the error code, the HTTP status when the host answered, the
 * message, the declared recovery, and the error's other fields as the host sent them.
 */
export const AppCommandFailure = Schema.Struct({
  code: Schema.String,
  status: Schema.optional(Schema.Int),
  message: Schema.String,
  recovery: Schema.optional(HostRecovery),
  details: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  /** Set when a newer CLI release exists: which one, and how to install it. */
  update: Schema.optional(Schema.String),
});
export type AppCommandFailure = typeof AppCommandFailure.Type;

const updateCli =
  "Check executor --version, then install the current release: npm i -g executor@beta --include=optional";
/** The wire form of a contract error: its code, message, recovery and other fields. */
const encodeOperationError = Schema.encodeUnknownOption(Schema.toCodecJson(AppOperationError));
const operationStatus = (error: unknown) => {
  for (const member of appOperationErrors)
    if (Schema.is(member)(error)) return SchemaAST.resolveAt<number>("httpApiStatus")(member.ast);
  return undefined;
};
const WireError = Schema.Struct({ _tag: Schema.String, message: Schema.String });
const presentation = new Set(["_tag", "message", "recovery"]);
/** The fields an error carries besides its code, message and recovery, such as a build's stage. */
const errorDetails = (wire: Record<string, Schema.Json>) => {
  const details = Object.entries(wire).filter(([key]) => !presentation.has(key));
  return details.length === 0 ? {} : { details: Object.fromEntries(details) };
};
/** What the host or the CLI said, for a request the host answered outside the contract. */
const hostRequestFailure = (error: HostRequestFailed): AppCommandFailure => {
  const request =
    error.method === undefined ? "the request" : `${error.method} ${error.path ?? ""}`;
  if (error.answer !== undefined)
    return {
      code: error.answer.code,
      ...(error.status === undefined ? {} : { status: error.status }),
      message: error.answer.message,
      ...(error.answer.recovery === undefined ? {} : { recovery: error.answer.recovery }),
    };
  const status = error.status === undefined ? {} : { status: error.status };
  if (error.reason === "network")
    return {
      code: "HostUnreachable",
      message: `${request} got no answer from the host.`,
      recovery: {
        action: "Check --host and your network connection, then retry.",
        instructions:
          "The request may not have reached the host. Confirm the host origin, then read the app's state before repeating a write.",
      },
    };
  if (error.reason === "response")
    return {
      code: "UnexpectedResponse",
      ...status,
      message: `The host's answer to ${request} does not match what this CLI expects, so the CLI and the host are probably different releases.`,
      recovery: {
        action: updateCli,
        instructions: `The host may have completed the operation: read the app's state before repeating it. ${updateCli}`,
      },
    };
  if (error.status === 404)
    return {
      code: "NotFound",
      ...status,
      message: `The host answered HTTP 404 to ${request}. This CLI may be older or newer than the host, which no longer serves or does not yet serve this request.`,
      recovery: {
        action: updateCli,
        instructions: `The host does not serve this route. ${updateCli}. Then run the command again.`,
      },
    };
  if (error.status === 413)
    return {
      code: "RequestTooLarge",
      ...status,
      message: `The host refused ${request} as too large (HTTP 413). Code is limited to ${formatCount(sourceLimits.files)} files and ${formatBytes(sourceLimits.bytes)} of UTF-8 text, and ui/public/ to ${formatCount(publicFileLimits.files)} files of at most ${formatCount(publicFileLimits.fileBytes)} bytes each.`,
      recovery: {
        action: "Remove generated or unneeded files from the source, then retry.",
        instructions: "Reduce the source below the limits; nothing was saved.",
      },
    };
  return {
    code: "UnexpectedStatus",
    ...status,
    message: `The host answered ${request} with HTTP ${error.status ?? "error"}, which this command does not expect.`,
    recovery: {
      action: "Retry. If it persists, report the command and this status.",
      instructions: `The host may have completed the operation: read the app's state before repeating a write. ${updateCli}`,
    },
  };
};

/**
 * Describe an apps command failure. Host errors keep their code, status, message and recovery
 * exactly as the host states them; the CLI's own failures say what it checked. Credentials and
 * other response text are never included. Undefined for failures outside the apps commands.
 */
export const describeAppFailure = (error: unknown): AppCommandFailure | undefined => {
  if (Schema.is(LocalServerUnavailable)(error))
    return { code: "LocalServerUnavailable", message: error.message };
  if (
    (Schema.is(AppClientError)(error) || Schema.is(AppAccessDenied)(error)) &&
    error.reason === "authentication"
  )
    return {
      code: "NotSignedIn",
      status: Schema.is(AppAccessDenied)(error) ? 403 : 401,
      message: notSignedIn,
    };
  if (Schema.is(AppClientError)(error))
    return {
      code: "Forbidden",
      status: 403,
      message:
        "This account cannot perform that action. Check the host, selected organization, and your role.",
    };
  if (Schema.is(HostRequestFailed)(error)) return hostRequestFailure(error);
  if (Schema.is(SourceRejected)(error))
    return {
      code: "SourceRejected",
      message: `${error.detail} Nothing was uploaded.`,
      details: { reason: error.reason, paths: [...error.paths] },
    };
  if (Schema.is(GitPushRefused)(error))
    return error.reason === "conflict"
      ? {
          code: "SourceConflict",
          status: 409,
          message: `The app's source changed since it was read (${error.detail}). Nothing was saved.`,
          recovery: {
            action:
              "Read the latest source with executor apps source, then save against its commit.",
            instructions:
              "Another write moved the app's working source. Read it again, reapply the change, and commit against the new revision.",
          },
        }
      : {
          code: "GitPushFailed",
          message: `Pushing the source with Git failed: ${error.detail}. The app's working source is unchanged.`,
          details: { reason: error.reason },
        };
  if (Schema.is(SkillLookupFailed)(error))
    return { code: "SkillLookupFailed", message: error.reason };
  if (Schema.is(LoginFailed)(error))
    return {
      code: "LoginFailed",
      message: loginFailure[error.reason],
      details: { reason: error.reason },
    };
  if (isPlatformError(error)) return { code: "LocalFileError", message: error.message };
  const wire = encodeOperationError(error);
  if (Option.isSome(wire)) {
    const fields = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(
      wire.value,
    );
    const known = Schema.decodeUnknownOption(WireError)(wire.value);
    if (Option.isSome(fields) && Option.isSome(known)) {
      const status = operationStatus(error);
      return {
        code: known.value._tag,
        ...(status === undefined ? {} : { status }),
        message: known.value.message,
        ...(UserFacingError.is(error) ? { recovery: error.recovery } : {}),
        ...errorDetails(fields.value),
      };
    }
  }
  // Skill reads use the SDK's own routes; their errors are schema classes with a declared status.
  if (error instanceof Error && Schema.isSchema(error.constructor)) {
    const status = SchemaAST.resolveAt<number>("httpApiStatus")(error.constructor.ast);
    return {
      code: SchemaAST.resolveIdentifier(error.constructor.ast) ?? error.name,
      ...(status === undefined ? {} : { status }),
      message: error.message,
      ...(UserFacingError.is(error) ? { recovery: error.recovery } : {}),
    };
  }
  return undefined;
};

/** One failure as people read it: the message, its code and status, then the recovery. */
export const renderAppFailure = (failure: AppCommandFailure): string =>
  [
    `Error: ${failure.message}`,
    `Code: ${failure.code}${failure.status === undefined ? "" : ` (HTTP ${failure.status})`}`,
    ...(failure.recovery === undefined
      ? []
      : [`Next step: ${failure.recovery.action}`, `For agents: ${failure.recovery.instructions}`]),
    ...(failure.update === undefined ? [] : [failure.update]),
  ].join("\n");

/** The failure as one JSON document, `{ "error": ... }`, for callers that parse stdout. */
export const encodeAppFailure = (failure: AppCommandFailure): string =>
  JSON.stringify({ error: Schema.encodeSync(AppCommandFailure)(failure) }, null, 2);

/**
 * The executable supplies one platform layer and owns process lifetime. `localServer` resolves the
 * local Executor that commands use when neither --host nor EXECUTOR_HOST names a host; without it,
 * such a command fails as not signed in.
 */
export const appsCommand = <E = never, R = never>(
  platform: string,
  localServer?: Effect.Effect<LocalServer, E, R>,
) => {
  /** Run with --host or EXECUTOR_HOST, or else the local server, resolved once per command. */
  const withHost = <A, E2, R2>(
    named: Option.Option<string>,
    run: (host: Host) => Effect.Effect<A, E2, R2>,
  ) =>
    Effect.gen(function* () {
      if (Option.isSome(named)) return yield* run({ origin: named.value });
      if (localServer === undefined) return yield* new AppClientError({ reason: "authentication" });
      const { url, token } = yield* localServer;
      return yield* run({ origin: url, local: token });
    });
  return Command.make("apps").pipe(
    Command.withDescription(
      `Create, edit, deploy, share, and install apps. Output is JSON on stdout. A failure exits 1 and prints the error's message, code, HTTP status and recovery on stderr; when stdout is not a terminal it also prints them as {"error": {"code", "status", "message", "recovery", "details", "update"}} on stdout; "update" says when a newer CLI release exists. Set EXECUTOR_HOST to skip --host; --organization defaults to the one you signed in to`,
    ),
    Command.withExamples([
      {
        command: `executor apps login --host ${hostedExecutorOrigin}`,
        description: "Sign in to hosted Executor once",
      },
      {
        command: `EXECUTOR_HOST=${hostedExecutorOrigin} executor apps list`,
        description: "List apps on the host you signed in to",
      },
      {
        command: "executor apps skills --app executor --name app-authoring --file deploy.md",
        description: "Read how to write and deploy an app",
      },
    ]),
    Command.withSubcommands([
      checkCommand,
      Command.make("login", {
        host: Flag.String("host").pipe(
          Flag.withDescription(
            `Hosted Executor origin, such as ${hostedExecutorOrigin}. Defaults to EXECUTOR_HOST`,
          ),
          Flag.withFallbackConfig(Config.String("EXECUTOR_HOST")),
        ),
      }).pipe(
        Command.withDescription(
          `Sign in to a hosted Executor with a code approved in any browser, for example --host ${hostedExecutorOrigin}`,
        ),
        Command.withExamples([
          {
            command: `executor apps login --host ${hostedExecutorOrigin}`,
            description: "Print a link and a code, and wait until it is approved in a browser",
          },
        ]),
        Command.withHandler((args) => registryLogin(args.host, platform)),
      ),
      Command.make("list", connection).pipe(
        Command.withDescription("List apps"),
        Command.withHandler((args) =>
          withHost(args.host, (host) =>
            manage(host, args.organization, (api, tenant) =>
              api
                .list({ params: tenant, responseMode: "decoded-and-response" })
                .pipe(Effect.flatMap(printResponse)),
            ),
          ),
        ),
      ),
      Command.make("create", { ...connection, name, files }).pipe(
        Command.withDescription(
          "Create an app from source files: a root index.ts and a package.json whose dependencies.apps is the version executor apps framework prints. Saving source does not run the app. Prints the app, including its id",
        ),
        Command.withExamples([
          {
            command: 'executor apps create --name "Hello" --files ./hello',
            description: "Create an app from the directory ./hello",
          },
          {
            command: 'executor apps create --name "Hello" --files ./files.json',
            description: 'Create an app from a JSON array of {"path", "content"} files',
          },
        ]),
        Command.withHandler((args) =>
          withHost(args.host, (host) =>
            Effect.gen(function* () {
              const local = yield* readSource(args.files);
              if (fitsRequest(local)) {
                const files = yield* requestFiles(local);
                return yield* manage(host, args.organization, (api, tenant) =>
                  api
                    .create({
                      params: tenant,
                      payload: { name: args.name, files },
                      responseMode: "decoded-and-response",
                    })
                    .pipe(Effect.flatMap(printResponse)),
                );
              }
              // Too large for one request: create the app from its code, then push the whole
              // directory, public files included, as its next commit.
              const [created, response] = yield* manage(host, args.organization, (api, tenant) =>
                requestFiles(codeOnly(local)).pipe(
                  Effect.flatMap((files) =>
                    api.create({
                      params: tenant,
                      payload: { name: args.name, files },
                      responseMode: "decoded-and-response",
                    }),
                  ),
                ),
              );
              const source = yield* workingSource(host, args.organization, created.id);
              yield* pushSource({
                url: source.gitUrl,
                authorization: yield* gitAuthorization(host, args.organization),
                expected: source.revision.commit,
                remote: source.files,
                files: local,
                message: "Add ui/public files",
              });
              yield* printResponse([created, response]);
            }),
          ),
        ),
      ),
      Command.make("framework", connection).pipe(
        Command.withDescription(
          "Print the exact apps framework version this host runs. Declare it as dependencies.apps in each app's package.json",
        ),
        Command.withHandler((args) =>
          withHost(args.host, (host) =>
            connect(host, args.organization).pipe(
              Effect.flatMap(({ framework, tenant }) =>
                framework.release({ params: tenant, responseMode: "decoded-and-response" }),
              ),
              Effect.flatMap(printResponse),
              Effect.catchIf(isTransportFailure, hostFailure),
            ),
          ),
        ),
      ),
      Command.make("source", {
        ...connection,
        app,
        out: Flag.Directory("out").pipe(
          Flag.withDescription(
            "Write the working source into this directory instead of printing it, binary ui/public/ files included. The directory must be empty or absent",
          ),
          Flag.optional,
        ),
      }).pipe(
        Command.withDescription(
          "Print an app's working source files and current commit. A ui/public/ file that is not text, or does not fit, is listed as {path, object, size}; pass --out to write every file",
        ),
        Command.withHandler((args) =>
          withHost(args.host, (host) =>
            Option.match(args.out, {
              onNone: () =>
                manage(host, args.organization, (api, tenant) =>
                  api
                    .source({
                      params: { ...tenant, app: args.app },
                      responseMode: "decoded-and-response",
                    })
                    .pipe(Effect.flatMap(printResponse)),
                ),
              onSome: (out) =>
                Effect.gen(function* () {
                  const fs = yield* FileSystem.FileSystem;
                  const path = yield* Path.Path;
                  if ((yield* fs.exists(out)) && (yield* fs.readDirectory(out)).length > 0)
                    return yield* new SourceRejected({
                      reason: "invalid",
                      detail: `${out} is not empty.`,
                      paths: [],
                    });
                  const source = yield* workingSource(host, args.organization, args.app);
                  const write = (file: string, bytes: Uint8Array) =>
                    Effect.gen(function* () {
                      const target = path.join(out, ...file.split("/"));
                      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
                      yield* fs.writeFile(target, bytes);
                    });
                  const stored = new Map<string, string[]>();
                  for (const file of source.files) {
                    if ("object" in file)
                      stored.set(file.object, [...(stored.get(file.object) ?? []), file.path]);
                    else yield* write(file.path, inlineBytes(file));
                  }
                  // Files listed by their blob come from the app's Git remote.
                  if (stored.size > 0)
                    yield* readCommitBlobs({
                      url: source.gitUrl,
                      authorization: yield* gitAuthorization(host, args.organization),
                      commit: source.revision.commit,
                      objects: [...stored.keys()],
                      write: (object, bytes) =>
                        Effect.forEach(stored.get(object) ?? [], (file) => write(file, bytes), {
                          discard: true,
                        }).pipe(Effect.mapError(() => new SourceError({ reason: "storage" }))),
                    });
                  yield* Console.log(
                    JSON.stringify(
                      { revision: source.revision, files: source.files.length, out },
                      null,
                      2,
                    ),
                  );
                }),
            }),
          ),
        ),
      ),
      Command.make("history", { ...connection, app }).pipe(
        Command.withDescription("List recent commits in an app's private Git history"),
        Command.withHandler((args) =>
          withHost(args.host, (host) =>
            manage(host, args.organization, (api, tenant) =>
              api
                .history({
                  params: { ...tenant, app: args.app },
                  responseMode: "decoded-and-response",
                })
                .pipe(Effect.flatMap(printResponse)),
            ),
          ),
        ),
      ),
      Command.make("git", { ...connection, app }).pipe(
        Command.withDescription(
          "Print the app's Git remote URL. Configure executor apps credential as the Git credential helper",
        ),
        Command.withExamples([
          {
            command:
              "git clone -c credential.helper= -c credential.helper='!executor apps credential' -c credential.useHttpPath=true \"$(executor apps git --app <app-id>)\"",
            description: "Clone the app's source; pushes save source but do not deploy it",
          },
        ]),
        Command.withHandler((args) =>
          withHost(args.host, (host) =>
            manage(host, args.organization, (api, tenant) =>
              api.git({ params: { ...tenant, app: args.app } }),
            ).pipe(Effect.flatMap((remote) => Console.log(remote.url))),
          ),
        ),
      ),
      Command.make("commit", {
        ...connection,
        app,
        files,
        expected: Flag.String("expected").pipe(
          Flag.withSchema(SourceCommit),
          Flag.withDescription(
            "Commit the edit is based on, from executor apps source; a newer commit rejects the save",
          ),
        ),
        message: Flag.String("message").pipe(
          Flag.withSchema(Schema.NonEmptyString),
          Flag.withDescription("Commit message"),
        ),
      }).pipe(
        Command.withDescription(
          "Save a complete new source snapshot as a commit without deploying it. Files missing from it are deleted. Prints the new revision, the count of removed files and at most 100 of their paths; deploy its commit with executor apps deploy",
        ),
        Command.withExamples([
          {
            command:
              'executor apps commit --app <app-id> --files ./hello --expected <last-commit> --message "Add search"',
            description: "Save ./hello as the next commit after <last-commit>",
          },
        ]),
        Command.withHandler((args) =>
          withHost(args.host, (host) =>
            Effect.gen(function* () {
              const files = yield* readSource(args.files);
              const committed = yield* saveSource({
                host,
                organization: args.organization,
                app: args.app,
                expected: args.expected,
                files,
                message: args.message,
              });
              yield* print(CommittedSource)(committed);
            }),
          ),
        ),
      ),
      Command.make("deploy", {
        ...connection,
        app,
        commit: commit("to build and activate").pipe(Flag.optional),
        files: files.pipe(
          Flag.withDescription(
            "A source directory to save on top of the working source and deploy, instead of --commit. Large and binary ui/public/ files are pushed with Git",
          ),
          Flag.optional,
        ),
        message: Flag.String("message").pipe(
          Flag.withSchema(Schema.NonEmptyString),
          Flag.withDescription("Commit message when deploying --files"),
          Flag.withDefault("Deploy"),
        ),
      }).pipe(
        Command.withDescription(
          "Build a saved commit, or save a source directory and build it, and make it the app's active version. A failed build leaves the active version unchanged and reports the failing stage, file and line",
        ),
        Command.withExamples([
          {
            command: "executor apps deploy --app <app-id> --commit <commit>",
            description: "Deploy the commit executor apps commit printed",
          },
          {
            command: "executor apps deploy --app <app-id> --files ./hello",
            description: "Save ./hello as the next commit and deploy it",
          },
        ]),
        Command.withHandler((args) =>
          withHost(args.host, (host) =>
            Effect.gen(function* () {
              if (Option.isSome(args.commit) === Option.isSome(args.files))
                return yield* new SourceRejected({
                  reason: "invalid",
                  detail: "Pass exactly one of --commit and --files.",
                  paths: [],
                });
              const target = Option.isSome(args.commit)
                ? args.commit.value
                : yield* Effect.gen(function* () {
                    const local = yield* readSource(Option.getOrThrow(args.files));
                    const head = yield* workingSource(host, args.organization, args.app);
                    const saved = yield* saveSource({
                      host,
                      organization: args.organization,
                      app: args.app,
                      expected: head.revision.commit,
                      files: local,
                      message: args.message,
                    });
                    return saved.revision.commit;
                  });
              yield* manage(host, args.organization, (api, tenant) =>
                api
                  .deploy({
                    params: { ...tenant, app: args.app },
                    payload: { commit: target },
                    responseMode: "decoded-and-response",
                  })
                  .pipe(Effect.flatMap(printResponse)),
              );
            }),
          ),
        ),
      ),
      Command.make("copy", { ...connection, app, name }).pipe(
        Command.withDescription(
          "Copy an app into a new app with fresh Git history. Accounts and app data are not copied",
        ),
        Command.withHandler((args) =>
          withHost(args.host, (host) =>
            manage(host, args.organization, (api, tenant) =>
              api
                .copy({
                  params: tenant,
                  payload: { from: { app: args.app }, name: args.name },
                  responseMode: "decoded-and-response",
                })
                .pipe(Effect.flatMap(printResponse)),
            ),
          ),
        ),
      ),
      Command.make("publish", { ...connection, app, commit: commit("to publish") }).pipe(
        Command.withDescription(
          "Publish a commit to the app registry. Its package.json name identifies the listing",
        ),
        Command.withHandler((args) =>
          withHost(args.host, (host) =>
            manage(host, args.organization, (api, tenant) =>
              api
                .publish({
                  params: { ...tenant, app: args.app },
                  payload: { commit: args.commit },
                  responseMode: "decoded-and-response",
                })
                .pipe(Effect.flatMap(printResponse)),
            ),
          ),
        ),
      ),
      Command.make("catalog", connection).pipe(
        Command.withDescription("List published apps available to install"),
        Command.withHandler((args) =>
          withHost(args.host, (host) =>
            manage(host, args.organization, (api, tenant) =>
              api
                .catalog({ params: tenant, query: {}, responseMode: "decoded-and-response" })
                .pipe(Effect.flatMap(printResponse)),
            ),
          ),
        ),
      ),
      Command.make("published", connection).pipe(
        Command.withDescription("List apps this account has published"),
        Command.withHandler((args) =>
          withHost(args.host, (host) =>
            manage(host, args.organization, (api, tenant) =>
              api
                .published({ params: tenant, responseMode: "decoded-and-response" })
                .pipe(Effect.flatMap(printResponse)),
            ),
          ),
        ),
      ),
      Command.make("install", { ...connection, ...publication, name }).pipe(
        Command.withDescription("Install a published app as a new, independently owned app"),
        Command.withHandler((args) =>
          withHost(args.host, (host) =>
            manage(host, args.organization, (api, tenant) =>
              api
                .copy({
                  params: tenant,
                  payload: {
                    from: { package: args.package, commit: args.commit },
                    name: args.name,
                  },
                  responseMode: "decoded-and-response",
                })
                .pipe(Effect.flatMap(printResponse)),
            ),
          ),
        ),
      ),
      Command.make("unpublish", { ...connection, package: publication.package }).pipe(
        Command.withDescription("Remove a published listing. Installed copies keep working"),
        Command.withHandler((args) =>
          withHost(args.host, (host) =>
            manage(host, args.organization, (api, tenant) =>
              api
                .unpublish({
                  params: tenant,
                  payload: { package: args.package },
                  responseMode: "decoded-and-response",
                })
                .pipe(Effect.flatMap(printResponse)),
            ),
          ),
        ),
      ),
      Command.make("skills", {
        ...connection,
        app: Flag.String("app").pipe(
          Flag.withDescription("App slug or ID. Omit to list skills from every deployed app"),
          Flag.optional,
        ),
        name: Flag.String("name").pipe(
          Flag.withSchema(AppSkillName),
          Flag.withDescription("Skill name to read, for example executor. Requires --app"),
          Flag.optional,
        ),
        file: Flag.String("file").pipe(
          Flag.withSchema(SourceFilePath),
          Flag.withDescription(
            "File within the skill to read instead of SKILL.md. Requires --name",
          ),
          Flag.optional,
        ),
      }).pipe(
        Command.withDescription(
          "List or read app skills served by the host. Start with --app executor --name executor, then read its app-authoring skill before writing an app",
        ),
        Command.withHandler((args) => withHost(args.host, (host) => readSkills({ ...args, host }))),
      ),
      Command.make("credential", {
        action: Argument.Literals("action", ["get", "store", "erase"]).pipe(
          Argument.withDescription(
            "Operation Git passes to the helper. get supplies the signed-in session for the remote's Git paths, including remotes on another origin than the host you signed in to; store and erase are ignored",
          ),
        ),
      }).pipe(
        Command.withDescription(
          "Git credential helper; set credential.useHttpPath=true, after an empty credential.helper so other helpers do not keep its short-lived tokens",
        ),
        Command.withHandler(({ action }) =>
          Effect.gen(function* () {
            if (action !== "get") return;
            const stdio = yield* Stdio.Stdio;
            const input = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
            const fields = new Map(
              input.split("\n").map((line) => {
                const split = line.indexOf("=");
                return [line.slice(0, split), line.slice(split + 1)];
              }),
            );
            const origin = `${fields.get("protocol")}://${fields.get("host")}`;
            if (!Schema.is(RegistryOrigin)(origin)) return;
            const session = Redacted.value(yield* gitSession(origin));
            if (!fields.get("path")?.startsWith(`git/${session.organization}/`)) return;
            // Git stores what a helper returns with every other helper it has, such as macOS's
            // keychain, and asks them first next time. With the expiry, Git (2.41 and later)
            // drops a kept copy when this helper would refresh it, instead of sending an expired
            // token that the host refuses as a failed sign-in.
            const expiry = Math.floor((session.expiresAt - sessionRefreshMarginMs) / 1000);
            yield* Stream.succeed(
              `username=executor\npassword=${session.accessToken}\npassword_expiry_utc=${expiry}\n\n`,
            ).pipe(Stream.run(stdio.stdout()));
          }),
        ),
      ),
    ]),
  );
};
