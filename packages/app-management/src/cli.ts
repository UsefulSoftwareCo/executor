/** Apps CLI and standard Git credential helper, sharing the product's app APIs. */
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Option,
  Redacted,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { SourceFiles } from "@executor-js/sdk/core";
import { AppClientError } from "./client-error.ts";
import { AppOperationError, AppAccessDenied } from "./contracts/api.ts";
import {
  AppNameTaken,
  AppDeploymentChanged,
  SourceError,
  DeploymentBuildFailed,
} from "@executor-js/sdk/core";
import { RegistryError } from "@executor-js/app-registry";
import { RegistryOrigin, registryLogin, registrySession } from "./implementation/node-auth.ts";

const host = Flag.String("host").pipe(Flag.withDefault("http://127.0.0.1:4312"));
const organization = Flag.String("organization").pipe(Flag.optional);
const connection = { host, organization };
const app = Flag.String("app");
const name = Flag.String("name");
const publication = { package: Flag.String("package"), commit: Flag.String("commit") };
const access = (host: string, organization: Option.Option<string>) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(RegistryOrigin)(host).pipe(
      Effect.mapError(() => new AppClientError({ reason: "authentication" })),
    );
    const token = yield* Config.Redacted("EXECUTOR_ACCESS_TOKEN").pipe(Config.option);
    if (Option.isSome(token)) {
      if (Option.isNone(organization))
        return yield* new AppClientError({ reason: "authentication" });
      return {
        token: token.value,
        prefix: `/api/organizations/${encodeURIComponent(organization.value)}`,
      };
    }
    const local = yield* Config.Redacted("EXECUTOR_API_KEY").pipe(Config.option);
    if (
      Option.isSome(local) &&
      Option.isNone(organization) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(new URL(host).hostname)
    )
      return { token: local.value, prefix: "/api" };
    const session = Redacted.value(yield* registrySession(host));
    if (Option.isSome(organization) && organization.value !== session.organization)
      return yield* new AppClientError({ reason: "forbidden" });
    return {
      token: Redacted.make(session.accessToken),
      prefix: `/api/organizations/${encodeURIComponent(session.organization)}`,
    };
  });
const request = (host: string, organization: Option.Option<string>, path: string, body?: object) =>
  Effect.gen(function* () {
    const credential = yield* access(host, organization);
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(host + credential.prefix + path, {
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
        Schema.is(AppClientError)(error) || Schema.is(AppOperationError)(error)
          ? error
          : new AppClientError({ reason: "request" }),
    });
  });
const send = (host: string, organization: Option.Option<string>, path: string, body?: object) =>
  request(host, organization, path, body).pipe(
    Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))),
  );
const readFiles = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SourceFiles))(
      yield* fs.readFileString(file),
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
  if (Schema.is(RegistryError)(error))
    return error.reason === "conflict"
      ? "That publishing name is used by another app. Choose another name."
      : `Registry operation failed (${error.reason}). Check the app name, selected commit, and registry connection.`;
  if (Schema.is(AppAccessDenied)(error) || Schema.is(AppClientError)(error))
    return error.reason === "authentication"
      ? "Sign in with executor apps login --host <origin> and try again."
      : error.reason === "forbidden"
        ? "This account cannot perform that action. Check the host, selected organization, and your role."
        : "The request could not be confirmed. Check the app state before retrying.";
  if (Schema.is(AppOperationError)(error))
    return "The app operation could not be completed. Check the app source and deployment state.";
  if (Schema.isSchemaError(error))
    return "Check the command options and source JSON. Use executor apps <command> --help for the expected input.";
  return undefined;
};

/** The executable supplies one platform layer and owns process lifetime. */
export const appsCommand = (platform: string) =>
  Command.make("apps").pipe(
    Command.withDescription("Create, edit, deploy, share, and install apps"),
    Command.withSubcommands([
      Command.make("login", { host }).pipe(
        Command.withHandler((args) => registryLogin(args.host, platform)),
      ),
      Command.make("list", connection).pipe(
        Command.withHandler((args) => send(args.host, args.organization, "/apps")),
      ),
      Command.make("create", {
        ...connection,
        name,
        files: Flag.File("files", { mustExist: true }).pipe(Flag.optional),
      }).pipe(
        Command.withHandler((args) =>
          Effect.gen(function* () {
            const files = Option.isSome(args.files) ? yield* readFiles(args.files.value) : starter;
            yield* send(args.host, args.organization, "/apps/drafts", { name: args.name, files });
          }),
        ),
      ),
      Command.make("source", { ...connection, app }).pipe(
        Command.withHandler((args) =>
          send(args.host, args.organization, `/apps/${encodeURIComponent(args.app)}/workspace`),
        ),
      ),
      Command.make("history", { ...connection, app }).pipe(
        Command.withHandler((args) =>
          send(args.host, args.organization, `/apps/${encodeURIComponent(args.app)}/history`),
        ),
      ),
      Command.make("git", { ...connection, app }).pipe(
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
        files: Flag.File("files", { mustExist: true }),
        expected: Flag.String("expected"),
        message: Flag.String("message"),
      }).pipe(
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
        commit: Flag.String("commit"),
      }).pipe(
        Command.withHandler((args) =>
          send(args.host, args.organization, `/apps/${encodeURIComponent(args.app)}/deploy`, {
            commit: args.commit,
          }),
        ),
      ),
      Command.make("copy", { ...connection, app, name }).pipe(
        Command.withHandler((args) =>
          send(args.host, args.organization, "/apps/copies", {
            from: { app: args.app },
            name: args.name,
          }),
        ),
      ),
      Command.make("publish", { ...connection, app, commit: Flag.String("commit") }).pipe(
        Command.withHandler((args) =>
          send(args.host, args.organization, `/apps/${encodeURIComponent(args.app)}/publication`, {
            commit: args.commit,
          }),
        ),
      ),
      Command.make("catalog", connection).pipe(
        Command.withHandler((args) => send(args.host, args.organization, "/app-publications")),
      ),
      Command.make("published", connection).pipe(
        Command.withHandler((args) =>
          send(args.host, args.organization, "/app-publications/published"),
        ),
      ),
      Command.make("install", { ...connection, ...publication, name }).pipe(
        Command.withHandler((args) =>
          send(args.host, args.organization, "/apps/copies", {
            from: { package: args.package, commit: args.commit },
            name: args.name,
          }),
        ),
      ),
      Command.make("unpublish", { ...connection, package: Flag.String("package") }).pipe(
        Command.withHandler((args) =>
          send(args.host, args.organization, "/app-publications/unpublish", {
            package: args.package,
          }),
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
