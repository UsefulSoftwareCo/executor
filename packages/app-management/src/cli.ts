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
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { PlatformError } from "effect/PlatformError";
import { SourceFiles } from "@executor-js/sdk/core";
import { AppClientError } from "./client-error.ts";
import { AppOperationError, AppAccessDenied } from "./contracts/api.ts";
import {
  AppNameTaken,
  AppDeploymentChanged,
  SourceError,
  DeploymentBuildFailed,
  BuildMemoryExceeded,
} from "@executor-js/sdk/core";
import { hostedExecutorOrigin, RegistryError } from "@executor-js/app-registry";
import { RegistryOrigin, registryLogin, registrySession } from "./implementation/node-auth.ts";

/** Skill lookups report the host's failure tag or the missing option; never a response body. */
class SkillLookupFailed extends Schema.TaggedError<SkillLookupFailed>()("SkillLookupFailed", {
  reason: Schema.String,
}) {}
const ErrorTag = Schema.Struct({ _tag: Schema.String });
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
const app = Flag.String("app").pipe(Flag.withDescription("App ID"));
const name = Flag.String("name").pipe(Flag.withDescription("Name for the new app"));
const commit = (purpose: string) =>
  Flag.String("commit").pipe(Flag.withDescription(`Full 40-character Git commit ${purpose}`));
const files = Flag.Path("files", { pathType: "either", mustExist: true }).pipe(
  Flag.withDescription(
    'Complete app source: a directory read recursively (skipping .git and node_modules), or a JSON file containing [{"path": "index.ts", "content": "..."}]. The source must include a root index.ts',
  ),
);
const publication = {
  package: Flag.String("package").pipe(
    Flag.withDescription("Published package name, for example @owner/app"),
  ),
  commit: commit("of the published version to install"),
};
const access = (host: string, organization: Option.Option<string>) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(RegistryOrigin)(host).pipe(
      Effect.mapError(() => new AppClientError({ reason: "authentication" })),
    );
    const token = yield* Config.Redacted("EXECUTOR_ACCESS_TOKEN").pipe(Config.option);
    if (Option.isSome(token)) {
      if (Option.isNone(organization))
        return yield* new AppClientError({ reason: "authentication" });
      const prefix = `/api/organizations/${encodeURIComponent(organization.value)}`;
      return { token: token.value, prefix, sdk: prefix };
    }
    const local = yield* Config.Redacted("EXECUTOR_API_KEY").pipe(Config.option);
    if (
      Option.isSome(local) &&
      Option.isNone(organization) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(new URL(host).hostname)
    )
      // Local skill and profile reads use the SDK routes the local MCP server also serves.
      return { token: local.value, prefix: "/api", sdk: "/v1" };
    const session = Redacted.value(yield* registrySession(host));
    if (Option.isSome(organization) && organization.value !== session.organization)
      return yield* new AppClientError({ reason: "forbidden" });
    const prefix = `/api/organizations/${encodeURIComponent(session.organization)}`;
    return { token: Redacted.make(session.accessToken), prefix, sdk: prefix };
  });
const request = (
  host: string,
  organization: Option.Option<string>,
  path: string,
  body?: object,
  api: "management" | "sdk" = "management",
) =>
  Effect.gen(function* () {
    const credential = yield* access(host, organization);
    const prefix = api === "sdk" ? credential.sdk : credential.prefix;
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(host + prefix + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${Redacted.value(credential.token)}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal,
        });
        const result: unknown = await response.json();
        if (!response.ok) {
          const error = Schema.decodeUnknownOption(Schema.toCodecJson(AppOperationError))(result);
          if (Option.isSome(error)) throw error.value;
          const tag = Schema.decodeUnknownOption(ErrorTag)(result);
          if (api === "sdk" && Option.isSome(tag) && response.status !== 401)
            throw new SkillLookupFailed({
              reason: `The host rejected the skill read (${tag.value._tag}).`,
            });
          throw new AppClientError({
            reason:
              response.status === 401
                ? "authentication"
                : response.status === 403
                  ? "forbidden"
                  : "request",
          });
        }
        return result;
      },
      catch: (error) =>
        Schema.is(AppClientError)(error) ||
        Schema.is(AppOperationError)(error) ||
        Schema.is(SkillLookupFailed)(error)
          ? error
          : new AppClientError({ reason: "request" }),
    });
  });
const send = (host: string, organization: Option.Option<string>, path: string, body?: object) =>
  request(host, organization, path, body).pipe(
    Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))),
  );
const ignoredSource = new Set([".git", "node_modules", ".DS_Store"]);
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
          .filter((entry) => !ignoredSource.has(entry))
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
const AppSummary = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  activeDeployment: Schema.NullOr(Schema.String),
  requirements: Schema.Struct({ accounts: Schema.Record(Schema.String, Schema.Unknown) }),
});
const ProfileSummary = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
  status: Schema.String,
});
const query = (entries: Record<string, Option.Option<string>>) => {
  const text = new URLSearchParams(
    Object.entries(entries).flatMap(([key, value]) =>
      Option.isSome(value) ? [[key, value.value]] : [],
    ),
  ).toString();
  return text === "" ? "" : `?${text}`;
};
/** Skills come from each app's deployment on the host; the CLI bundles no guidance. */
const readSkills = (args: {
  readonly host: string;
  readonly organization: Option.Option<string>;
  readonly app: Option.Option<string>;
  readonly profile: Option.Option<string>;
  readonly name: Option.Option<string>;
  readonly file: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    if (Option.isNone(args.name) && Option.isSome(args.file))
      return yield* new SkillLookupFailed({ reason: "Pass --name with --file." });
    if (Option.isNone(args.app) && (Option.isSome(args.name) || Option.isSome(args.profile)))
      return yield* new SkillLookupFailed({ reason: "Pass --app with --name or --profile." });
    const get = (path: string) => request(args.host, args.organization, path, undefined, "sdk");
    const apps = yield* request(args.host, args.organization, "/apps").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AppSummary))),
    );
    // The same targets as the MCP skills tool: the app itself when it needs no accounts, and
    // each usable account profile.
    const targets = (app: typeof AppSummary.Type) =>
      get(`/apps/${encodeURIComponent(app.id)}/profiles`).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ProfileSummary))),
        Effect.map((profiles) => [
          ...(Object.keys(app.requirements.accounts).length === 0 ? [Option.none<string>()] : []),
          ...profiles
            .filter(
              (profile) =>
                profile.enabled && profile.status !== "removed" && profile.status !== "removing",
            )
            .map((profile) => Option.some(profile.id)),
        ]),
      );
    const catalog = (app: typeof AppSummary.Type, profile: Option.Option<string>) =>
      get(`/apps/${encodeURIComponent(app.id)}/skills${query({ profile })}`);
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
      return {
        catalogs: results.flatMap((entry) => entry.catalogs ?? []),
        unavailable: results.flatMap((entry) => (entry.catalogs === undefined ? [entry.app] : [])),
      };
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
    if (Option.isNone(args.name)) return yield* catalog(selected, profile);
    return yield* get(
      `/apps/${encodeURIComponent(selected.id)}/skills/${encodeURIComponent(args.name.value)}${query({ profile, file: args.file })}`,
    );
  });

const starter = SourceFiles.make([
  {
    path: "index.ts",
    content:
      'import {defineApp,object,query} from "apps";\nexport default defineApp({accounts:{}},async()=>({queries:{hello:query({description:"Say hello",input:object({})},async()=>({message:"Hello"}))}}));\n',
  },
]);

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
  if (Schema.is(DeploymentBuildFailed)(error)) return error.reason;
  if (Schema.is(SkillLookupFailed)(error)) return error.reason;
  if (Schema.is(BuildMemoryExceeded)(error)) return `${error.description} ${error.recovery.action}`;
  if (Schema.is(RegistryError)(error))
    return error.reason === "conflict"
      ? "That publishing name is used by another app. Choose another name."
      : `Registry operation failed (${error.reason}${error.status === undefined ? "" : ` ${error.status}`}). Check the app name, selected commit, and registry connection.`;
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
          `Sign in to a hosted Executor through the browser, for example --host ${hostedExecutorOrigin}`,
        ),
        Command.withHandler((args) => registryLogin(args.host, platform)),
      ),
      Command.make("list", connection).pipe(
        Command.withDescription("List apps"),
        Command.withHandler((args) => send(args.host, args.organization, "/apps")),
      ),
      Command.make("create", {
        ...connection,
        name,
        files: files.pipe(Flag.optional),
      }).pipe(
        Command.withDescription(
          "Create a draft app from source files, or from a starter app when --files is omitted. Saving source does not run the app",
        ),
        Command.withHandler((args) =>
          Effect.gen(function* () {
            const files = Option.isSome(args.files) ? yield* readFiles(args.files.value) : starter;
            yield* send(args.host, args.organization, "/apps/drafts", { name: args.name, files });
          }),
        ),
      ),
      Command.make("source", { ...connection, app }).pipe(
        Command.withDescription("Print an app's working source files and current commit"),
        Command.withHandler((args) =>
          send(args.host, args.organization, `/apps/${encodeURIComponent(args.app)}/workspace`),
        ),
      ),
      Command.make("history", { ...connection, app }).pipe(
        Command.withDescription("List recent commits in an app's private Git history"),
        Command.withHandler((args) =>
          send(args.host, args.organization, `/apps/${encodeURIComponent(args.app)}/history`),
        ),
      ),
      Command.make("git", { ...connection, app }).pipe(
        Command.withDescription(
          "Print the app's Git remote URL. Configure executor apps credential as the Git credential helper",
        ),
        Command.withHandler((args) =>
          request(args.host, args.organization, `/apps/${encodeURIComponent(args.app)}/git`).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ path: Schema.String }))),
            Effect.flatMap((remote) => Console.log(args.host + remote.path)),
          ),
        ),
      ),
      Command.make("commit", {
        ...connection,
        app,
        files,
        expected: Flag.String("expected").pipe(
          Flag.withDescription(
            "Commit the edit is based on, from executor apps source; a newer commit rejects the save",
          ),
        ),
        message: Flag.String("message").pipe(Flag.withDescription("Commit message")),
      }).pipe(
        Command.withDescription(
          "Save a complete new source snapshot as a commit without deploying it",
        ),
        Command.withHandler((args) =>
          Effect.gen(function* () {
            yield* send(
              args.host,
              args.organization,
              `/apps/${encodeURIComponent(args.app)}/commits`,
              {
                expected: args.expected,
                files: yield* readFiles(args.files),
                message: args.message,
              },
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
          send(args.host, args.organization, `/apps/${encodeURIComponent(args.app)}/deploy`, {
            commit: args.commit,
          }),
        ),
      ),
      Command.make("copy", { ...connection, app, name }).pipe(
        Command.withDescription(
          "Copy an app into a new app with fresh Git history. Accounts and app data are not copied",
        ),
        Command.withHandler((args) =>
          send(args.host, args.organization, "/apps/copies", {
            from: { app: args.app },
            name: args.name,
          }),
        ),
      ),
      Command.make("publish", { ...connection, app, commit: commit("to publish") }).pipe(
        Command.withDescription(
          "Publish a commit to the app registry. Its package.json name identifies the listing",
        ),
        Command.withHandler((args) =>
          send(args.host, args.organization, `/apps/${encodeURIComponent(args.app)}/publication`, {
            commit: args.commit,
          }),
        ),
      ),
      Command.make("catalog", connection).pipe(
        Command.withDescription("List published apps available to install"),
        Command.withHandler((args) => send(args.host, args.organization, "/app-publications")),
      ),
      Command.make("published", connection).pipe(
        Command.withDescription("List apps this account has published"),
        Command.withHandler((args) =>
          send(args.host, args.organization, "/app-publications/published"),
        ),
      ),
      Command.make("install", { ...connection, ...publication, name }).pipe(
        Command.withDescription("Install a published app as a new, independently owned app"),
        Command.withHandler((args) =>
          send(args.host, args.organization, "/apps/copies", {
            from: { package: args.package, commit: args.commit },
            name: args.name,
          }),
        ),
      ),
      Command.make("unpublish", { ...connection, package: publication.package }).pipe(
        Command.withDescription("Remove a published listing. Installed copies keep working"),
        Command.withHandler((args) =>
          send(args.host, args.organization, "/app-publications/unpublish", {
            package: args.package,
          }),
        ),
      ),
      Command.make("skills", {
        ...connection,
        app: Flag.String("app").pipe(
          Flag.withDescription("App slug or ID. Omit to list skills from every deployed app"),
          Flag.optional,
        ),
        profile: Flag.String("profile").pipe(
          Flag.withDescription("Account profile ID for apps whose skills need accounts"),
          Flag.optional,
        ),
        name: Flag.String("name").pipe(
          Flag.withDescription("Skill name to read, for example app-authoring. Requires --app"),
          Flag.optional,
        ),
        file: Flag.String("file").pipe(
          Flag.withDescription(
            "File within the skill to read instead of SKILL.md. Requires --name",
          ),
          Flag.optional,
        ),
      }).pipe(
        Command.withDescription(
          "List or read app skills served by the host. Start with --app executor --name app-authoring before writing an app",
        ),
        Command.withHandler((args) =>
          readSkills(args).pipe(
            Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))),
          ),
        ),
      ),
      Command.make("credential", {
        action: Argument.Literals("action", ["get", "store", "erase"]),
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
            const host = `${fields.get("protocol")}://${fields.get("host")}`;
            if (!Schema.is(RegistryOrigin)(host)) return;
            const session = Redacted.value(yield* registrySession(host));
            if (!fields.get("path")?.startsWith(`git/${session.organization}/`)) return;
            yield* Stream.succeed(`username=executor\npassword=${session.accessToken}\n\n`).pipe(
              Stream.run(stdio.stdout()),
            );
          }),
        ),
      ),
    ]),
  );
