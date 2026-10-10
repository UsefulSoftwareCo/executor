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
import type { PlatformError } from "effect/PlatformError";
import {
  AppDeploymentChanged,
  AppId,
  AppName,
  AppNameTaken,
  AppSkillCatalog,
  AppSkillDocument,
  AppSkillName,
  BuildMemoryExceeded,
  CommittedSource,
  DeploymentBuildFailed,
  ExecutorApi,
  ProfileId,
  SourceCommit,
  SourceError,
  SourceFilePath,
  SourceFiles,
  PackageName,
  RegistryError,
  hostedExecutorOrigin,
  type App,
} from "@executor-js/sdk/core";
import { AppClientError, LoginFailed } from "./client-error.ts";
import {
  AppAccess,
  AppAccessDenied,
  AppOperationError,
  appManagementApi,
} from "./contracts/api.ts";
import { frameworkApi } from "./contracts/framework.ts";
import {
  RegistryOrigin,
  gitSession,
  registryLogin,
  registrySession,
} from "./implementation/node-auth.ts";

/** Skill lookups report the host's failure tag or the missing option; never a response body. */
class SkillLookupFailed extends Schema.TaggedError<SkillLookupFailed>()("SkillLookupFailed", {
  reason: Schema.String,
}) {}
const localOrigin = "http://127.0.0.1:4312";
const host = Flag.String("host").pipe(
  Flag.withDescription(
    `Executor origin. Defaults to the local server; use ${hostedExecutorOrigin} for hosted Executor`,
  ),
  Flag.withDefault(localOrigin),
);
const organization = Flag.String("organization").pipe(
  Flag.withDescription(
    "Hosted organization. Required with EXECUTOR_ACCESS_TOKEN; after executor apps login it defaults to the signed-in organization",
  ),
  Flag.optional,
);
const connection = { host, organization };
const app = Flag.String("app").pipe(Flag.withSchema(AppId), Flag.withDescription("App ID"));
const name = Flag.String("name").pipe(
  Flag.withSchema(AppName),
  Flag.withDescription("Name for the new app"),
);
const commit = (purpose: string) =>
  Flag.String("commit").pipe(
    Flag.withSchema(SourceCommit),
    Flag.withDescription(`Full 40-character Git commit ${purpose}`),
  );
const ignoredSource = [".git", "node_modules", ".DS_Store"];
const files = Flag.Path("files", { pathType: "either", mustExist: true }).pipe(
  Flag.withDescription(
    `Complete app source: a directory read recursively (skipping ${ignoredSource.join(", ")}), or a JSON file containing [{"path": "index.ts", "content": "..."}]. The source must include a root index.ts`,
  ),
);
const publication = {
  package: Flag.String("package").pipe(
    Flag.withSchema(PackageName),
    Flag.withDescription("Published package name, for example @owner/app"),
  ),
  commit: commit("of the published version to install"),
};
/** Resolve the credential and, for hosted Executor, the organization every request targets. */
const access = (host: string, organization: Option.Option<string>) =>
  Effect.gen(function* () {
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
        ),
      ),
      HttpClient.transform((response) =>
        Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "error" }),
      ),
    ),
  ).pipe(Effect.provide(FetchHttpClient.layer));
/** Transport failures become sanitized client errors; bodies and credentials are never shown. */
const clientError = (error: HttpClientError.HttpClientError | Schema.SchemaError) =>
  new AppClientError({
    reason:
      HttpClientError.isHttpClientError(error) && error.response?.status === 401
        ? "authentication"
        : HttpClientError.isHttpClientError(error) && error.response?.status === 403
          ? "forbidden"
          : "request",
  });
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
 * Typed clients for one host. App management uses its shared contract. Skill and profile reads
 * use the SDK routes: local serves them under /v1, and hosted serves the same endpoints and
 * schemas under its organization prefix.
 */
const connect = (host: string, organization: Option.Option<string>) =>
  Effect.gen(function* () {
    const target = yield* access(host, organization);
    const httpClient = yield* transport(host, target.token);
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
        profiles: yield* HttpApiClient.group(ExecutorApi, { group: "appProfiles", httpClient }),
      };
    }
    const prefix = `/api/organizations/${encodeURIComponent(target.organization)}`;
    const sdkClient = yield* transport(host, target.token, (url) =>
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
      profiles: yield* HttpApiClient.group(ExecutorApi, {
        group: "appProfiles",
        httpClient: sdkClient,
      }),
    };
  });
/** Run one app management operation; contract errors stay typed for command diagnostics. */
const manage = <A, E>(
  host: string,
  organization: Option.Option<string>,
  operation: (
    api: Management,
    tenant: { readonly organization?: string },
  ) => Effect.Effect<A, E | HttpClientError.HttpClientError | Schema.SchemaError>,
) =>
  connect(host, organization).pipe(
    Effect.flatMap(({ management, tenant }) => operation(management, tenant)),
    Effect.catchIf(isTransportFailure, (error) => Effect.fail(clientError(error))),
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
/** Read a JSON source list, or every file under a directory with POSIX paths relative to it. */
const readFiles = (location: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if ((yield* fs.stat(location)).type !== "Directory")
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SourceFiles))(
        yield* fs.readFileString(location),
      );
    const walk = (
      relative: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<{ path: string; content: string }>, PlatformError> =>
      Effect.gen(function* () {
        const directory = path.join(location, ...relative);
        const entries = (yield* fs.readDirectory(directory))
          .filter((entry) => !ignoredSource.includes(entry))
          .sort();
        const nested = yield* Effect.forEach(entries, (entry) =>
          Effect.gen(function* () {
            const segments = [...relative, entry];
            const info = yield* fs.stat(path.join(directory, entry));
            if (info.type === "Directory") return yield* walk(segments);
            if (info.type !== "File") return [];
            return [
              {
                path: segments.join("/"),
                content: yield* fs.readFileString(path.join(directory, entry)),
              },
            ];
          }),
        );
        return nested.flat();
      });
    return yield* Schema.decodeUnknownEffect(SourceFiles)(yield* walk([]));
  });
/** Skill lookups print the host's result for all deployed apps, one catalog, or one document. */
const SkillListing = Schema.Struct({
  catalogs: Schema.Array(AppSkillCatalog),
  unavailable: Schema.Array(Schema.String),
});
/** A skill read the host rejects reports its failure tag; transport failures stay sanitized. */
const skillRead = <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E | HttpClientError.HttpClientError | Schema.SchemaError>,
) =>
  effect.pipe(
    Effect.catchIf(isTransportFailure, (error) => Effect.fail(clientError(error))),
    Effect.mapError((error) =>
      Schema.is(AppClientError)(error)
        ? error
        : new SkillLookupFailed({ reason: `The host rejected the skill read (${error._tag}).` }),
    ),
  );
/** Skills come from each app's deployment on the host; the CLI bundles no guidance. */
const readSkills = (args: {
  readonly host: string;
  readonly organization: Option.Option<string>;
  readonly app: Option.Option<string>;
  readonly profile: Option.Option<ProfileId>;
  readonly name: Option.Option<typeof AppSkillName.Type>;
  readonly file: Option.Option<typeof SourceFilePath.Type>;
}) =>
  Effect.gen(function* () {
    if (Option.isNone(args.name) && Option.isSome(args.file))
      return yield* new SkillLookupFailed({ reason: "Pass --name with --file." });
    if (Option.isNone(args.app) && (Option.isSome(args.name) || Option.isSome(args.profile)))
      return yield* new SkillLookupFailed({ reason: "Pass --app with --name or --profile." });
    const { management, tenant, skills, profiles } = yield* connect(args.host, args.organization);
    const apps = yield* management
      .list({ params: tenant })
      .pipe(Effect.catchIf(isTransportFailure, (error) => Effect.fail(clientError(error))));
    // The same targets as the MCP skills tool: the app itself when it needs no accounts, and
    // each usable account profile.
    const targets = (app: App) =>
      skillRead(profiles.list({ params: { app: app.id }, query: {} })).pipe(
        Effect.map((profiles) => [
          ...(Object.keys(app.requirements.accounts).length === 0
            ? [Option.none<ProfileId>()]
            : []),
          ...profiles
            .filter(
              (profile) =>
                profile.enabled && profile.status !== "removed" && profile.status !== "removing",
            )
            .map((profile) => Option.some(profile.id)),
        ]),
      );
    const catalog = (app: App, profile: Option.Option<ProfileId>) =>
      skillRead(
        skills.list({
          params: { app: app.id },
          query: { profile: Option.getOrUndefined(profile) },
        }),
      );
    if (Option.isNone(args.app)) {
      const results = yield* Effect.forEach(
        apps.filter((app) => app.activeDeployment !== null),
        (app) =>
          targets(app).pipe(
            Effect.flatMap((profiles) =>
              Effect.forEach(profiles, (profile) => catalog(app, profile)),
            ),
            Effect.map((catalogs) => ({ app: app.slug, catalogs })),
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
    let profile = args.profile;
    if (Option.isNone(profile) && Object.keys(selected.requirements.accounts).length > 0) {
      const available = yield* targets(selected);
      const only = available[0];
      if (available.length !== 1 || only === undefined)
        return yield* new SkillLookupFailed({
          reason:
            available.length === 0
              ? `${slug} needs an account profile. Set up the app's accounts first.`
              : `${slug} has several account profiles. Pass --profile with one of: ${available.flatMap((id) => (Option.isSome(id) ? [id.value] : [])).join(", ")}.`,
        });
      profile = only;
    }
    if (Option.isNone(args.name))
      return yield* catalog(selected, profile).pipe(Effect.flatMap(print(AppSkillCatalog)));
    return yield* skillRead(
      skills.read({
        params: { app: selected.id, name: args.name.value },
        query: { profile: Option.getOrUndefined(profile), file: Option.getOrUndefined(args.file) },
      }),
    ).pipe(Effect.flatMap(print(AppSkillDocument)));
  });

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

/** Sanitized command diagnostics. Credential values and arbitrary server bodies are never printed. */
export const appCommandFailure = (error: unknown): string | undefined => {
  if (Schema.is(AppNameTaken)(error))
    return "An app already uses this name. Open it or choose another name.";
  if (Schema.is(AppDeploymentChanged)(error))
    return "The active deployment changed. Read the app again before deploying.";
  if (Schema.is(SourceError)(error))
    return error.reason === "conflict"
      ? "The source changed. Read the latest commit before saving or deploying."
      : "The Git source could not be read or saved. Check the repository and retry.";
  if (Schema.is(DeploymentBuildFailed)(error)) return error.message;
  if (Schema.is(SkillLookupFailed)(error)) return error.reason;
  if (Schema.is(BuildMemoryExceeded)(error)) return `${error.description} ${error.recovery.action}`;
  if (Schema.is(RegistryError)(error))
    return error.reason === "conflict"
      ? "That publishing name is used by another app. Choose another name."
      : `Registry operation failed (${error.reason}${error.status === undefined ? "" : ` ${error.status}`}). Check the app name, selected commit, and registry connection.`;
  if (Schema.is(LoginFailed)(error)) return loginFailure[error.reason];
  if (Schema.is(AppAccessDenied)(error) || Schema.is(AppClientError)(error))
    return error.reason === "authentication"
      ? `Not signed in to this host. For hosted Executor, run executor apps login --host ${hostedExecutorOrigin} and pass the same --host to each command. For a local server (default ${localOrigin}), set EXECUTOR_API_KEY to its API key.`
      : error.reason === "forbidden"
        ? "This account cannot perform that action. Check the host, selected organization, and your role."
        : "The request could not be confirmed. Check the app state before retrying.";
  if (Schema.is(AppOperationError)(error))
    return "The app operation could not be completed. Check the app source and deployment state.";
  if (Schema.isSchemaError(error))
    return "Check the command options and source files. Use executor apps <command> --help for the expected input.";
  return undefined;
};

/** The executable supplies one platform layer and owns process lifetime. */
export const appsCommand = (platform: string) =>
  Command.make("apps").pipe(
    Command.withDescription("Create, edit, deploy, share, and install apps"),
    Command.withSubcommands([
      Command.make("login", { host }).pipe(
        Command.withDescription(
          `Sign in to a hosted Executor with a code approved in any browser, for example --host ${hostedExecutorOrigin}`,
        ),
        Command.withHandler((args) => registryLogin(args.host, platform)),
      ),
      Command.make("list", connection).pipe(
        Command.withDescription("List apps"),
        Command.withHandler((args) =>
          manage(args.host, args.organization, (api, tenant) =>
            api
              .list({ params: tenant, responseMode: "decoded-and-response" })
              .pipe(Effect.flatMap(printResponse)),
          ),
        ),
      ),
      Command.make("create", { ...connection, name, files }).pipe(
        Command.withDescription(
          "Create an app from source files: a root index.ts and a package.json whose dependencies.apps is the version executor apps framework prints. Saving source does not run the app",
        ),
        Command.withHandler((args) =>
          Effect.gen(function* () {
            const files = yield* readFiles(args.files);
            yield* manage(args.host, args.organization, (api, tenant) =>
              api
                .create({
                  params: tenant,
                  payload: { name: args.name, files },
                  responseMode: "decoded-and-response",
                })
                .pipe(Effect.flatMap(printResponse)),
            );
          }),
        ),
      ),
      Command.make("framework", connection).pipe(
        Command.withDescription(
          "Print the exact apps framework version this host runs. Declare it as dependencies.apps in each app's package.json",
        ),
        Command.withHandler((args) =>
          connect(args.host, args.organization).pipe(
            Effect.flatMap(({ framework, tenant }) =>
              framework.release({ params: tenant, responseMode: "decoded-and-response" }),
            ),
            Effect.flatMap(printResponse),
            Effect.catchIf(isTransportFailure, (error) => Effect.fail(clientError(error))),
          ),
        ),
      ),
      Command.make("source", { ...connection, app }).pipe(
        Command.withDescription("Print an app's working source files and current commit"),
        Command.withHandler((args) =>
          manage(args.host, args.organization, (api, tenant) =>
            api
              .source({
                params: { ...tenant, app: args.app },
                responseMode: "decoded-and-response",
              })
              .pipe(Effect.flatMap(printResponse)),
          ),
        ),
      ),
      Command.make("history", { ...connection, app }).pipe(
        Command.withDescription("List recent commits in an app's private Git history"),
        Command.withHandler((args) =>
          manage(args.host, args.organization, (api, tenant) =>
            api
              .history({
                params: { ...tenant, app: args.app },
                responseMode: "decoded-and-response",
              })
              .pipe(Effect.flatMap(printResponse)),
          ),
        ),
      ),
      Command.make("git", { ...connection, app }).pipe(
        Command.withDescription(
          "Print the app's Git remote URL. Configure executor apps credential as the Git credential helper",
        ),
        Command.withHandler((args) =>
          manage(args.host, args.organization, (api, tenant) =>
            api.git({ params: { ...tenant, app: args.app } }),
          ).pipe(Effect.flatMap((remote) => Console.log(remote.url))),
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
          "Save a complete new source snapshot as a commit without deploying it. Prints the new revision; deploy its commit with executor apps deploy",
        ),
        Command.withHandler((args) =>
          Effect.gen(function* () {
            const files = yield* readFiles(args.files);
            yield* manage(args.host, args.organization, (api, tenant) =>
              api
                .commit({
                  params: { ...tenant, app: args.app },
                  payload: { expected: args.expected, files, message: args.message },
                })
                .pipe(Effect.flatMap(print(CommittedSource))),
            );
          }),
        ),
      ),
      Command.make("deploy", {
        ...connection,
        app,
        commit: commit("to build and activate"),
      }).pipe(
        Command.withDescription("Build a saved commit and make it the app's active deployment"),
        Command.withHandler((args) =>
          manage(args.host, args.organization, (api, tenant) =>
            api
              .deploy({
                params: { ...tenant, app: args.app },
                payload: { commit: args.commit },
                responseMode: "decoded-and-response",
              })
              .pipe(Effect.flatMap(printResponse)),
          ),
        ),
      ),
      Command.make("copy", { ...connection, app, name }).pipe(
        Command.withDescription(
          "Copy an app into a new app with fresh Git history. Accounts and app data are not copied",
        ),
        Command.withHandler((args) =>
          manage(args.host, args.organization, (api, tenant) =>
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
      Command.make("publish", { ...connection, app, commit: commit("to publish") }).pipe(
        Command.withDescription(
          "Publish a commit to the app registry. Its package.json name identifies the listing",
        ),
        Command.withHandler((args) =>
          manage(args.host, args.organization, (api, tenant) =>
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
      Command.make("catalog", connection).pipe(
        Command.withDescription("List published apps available to install"),
        Command.withHandler((args) =>
          manage(args.host, args.organization, (api, tenant) =>
            api
              .catalog({ params: tenant, query: {}, responseMode: "decoded-and-response" })
              .pipe(Effect.flatMap(printResponse)),
          ),
        ),
      ),
      Command.make("published", connection).pipe(
        Command.withDescription("List apps this account has published"),
        Command.withHandler((args) =>
          manage(args.host, args.organization, (api, tenant) =>
            api
              .published({ params: tenant, responseMode: "decoded-and-response" })
              .pipe(Effect.flatMap(printResponse)),
          ),
        ),
      ),
      Command.make("install", { ...connection, ...publication, name }).pipe(
        Command.withDescription("Install a published app as a new, independently owned app"),
        Command.withHandler((args) =>
          manage(args.host, args.organization, (api, tenant) =>
            api
              .copy({
                params: tenant,
                payload: { from: { package: args.package, commit: args.commit }, name: args.name },
                responseMode: "decoded-and-response",
              })
              .pipe(Effect.flatMap(printResponse)),
          ),
        ),
      ),
      Command.make("unpublish", { ...connection, package: publication.package }).pipe(
        Command.withDescription("Remove a published listing. Installed copies keep working"),
        Command.withHandler((args) =>
          manage(args.host, args.organization, (api, tenant) =>
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
      Command.make("skills", {
        ...connection,
        app: Flag.String("app").pipe(
          Flag.withDescription("App slug or ID. Omit to list skills from every deployed app"),
          Flag.optional,
        ),
        profile: Flag.String("profile").pipe(
          Flag.withSchema(ProfileId),
          Flag.withDescription("Account profile ID for apps whose skills need accounts"),
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
        Command.withHandler(readSkills),
      ),
      Command.make("credential", {
        action: Argument.Literals("action", ["get", "store", "erase"]).pipe(
          Argument.withDescription(
            "Operation Git passes to the helper. get supplies the signed-in session for the remote's Git paths, including remotes on another origin than the host you signed in to; store and erase are ignored",
          ),
        ),
      }).pipe(
        Command.withDescription("Git credential helper; set credential.useHttpPath=true"),
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
            yield* Stream.succeed(`username=executor\npassword=${session.accessToken}\n\n`).pipe(
              Stream.run(stdio.stdout()),
            );
          }),
        ),
      ),
    ]),
  );
