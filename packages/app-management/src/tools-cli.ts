/**
 * Top-level client commands: sign-in for a host's tools, and the MCP tools themselves. Each tool
 * command calls the MCP tool of the same name on the resolved host and prints its result as JSON
 * on stdout; failures follow the `executor apps` convention.
 */
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
import { Argument, Command, Flag } from "effect/cli";
import { McpWhoami } from "@executor-js/mcp-auth/grants";
import { hostedExecutorOrigin } from "@executor-js/sdk/core";
import { ToolInputInvalid, ToolsSignInRequired } from "./client-error.ts";
import { hostFlag, namedHost, toolsTarget, type LocalServer } from "./implementation/hosts.ts";
import { hasRegistrySession, logout, toolsLogin } from "./implementation/node-auth.ts";

/**
 * The MCP client and the paused-call records, loaded when a command uses them, so other commands
 * and help start without the MCP SDK.
 */
const toolsClient = Effect.promise(() => import("./implementation/tools-client.ts"));
const pausedCalls = Effect.promise(() => import("./implementation/paused-calls.ts"));

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

/** Read a file, or standard input when the path is `-`. */
const readInput = (file: string) =>
  file === "-"
    ? Effect.flatMap(Stdio.Stdio, (stdio) => stdio.stdin.pipe(Stream.decodeText(), Stream.mkString))
    : Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file));

/**
 * The text one of two exclusive flags supplies: inline, or from a file or standard input (`-`).
 * Neither gives `none`; both fail.
 */
const textFrom = (inline: Option.Option<string>, file: Option.Option<string>, names: string) =>
  Effect.gen(function* () {
    if (Option.isSome(inline) && Option.isSome(file))
      return yield* new ToolInputInvalid({ message: `Pass only one of ${names}.` });
    if (Option.isSome(inline)) return inline;
    if (Option.isSome(file)) return Option.some(yield* readInput(file.value));
    return Option.none<string>();
  });

/** JSON from one of two exclusive flags; `what` names it in the error. */
const jsonFrom = (
  inline: Option.Option<string>,
  file: Option.Option<string>,
  names: string,
  what: string,
) =>
  textFrom(inline, file, names).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (text) =>
          decodeJson(text).pipe(
            Effect.map(Option.some),
            Effect.mapError(() => new ToolInputInvalid({ message: `${what} is not valid JSON.` })),
          ),
      }),
    ),
  );

const fileFlag = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);

/**
 * What tool commands print. Failures exit 1 as `executor apps` failures do: the message, code and
 * recovery on stderr, and `{"error": ...}` on stdout when stdout is not a terminal.
 */
const prints = "Prints the result as JSON";
const pauses = `${prints}. A paused call prints its pending request, with an approvalUrl when the host gives one; continue it with executor resume`;

/**
 * The tool commands, `login`, `logout`, `whoami` and `mcp`. `localServer` resolves the local
 * Executor that commands use when no host is named or remembered.
 */
export const toolCommands = <E, R>(
  platform: string,
  localServer?: Effect.Effect<LocalServer, E, R>,
) => {
  /**
   * Call one MCP tool on the resolved host and print its result. A call paused for browser
   * approval is answered in the session that made it, so `resume` continues that session.
   */
  const run = (
    host: Option.Option<string>,
    tool: string,
    input: Record<string, unknown>,
    resumed?: string,
  ) =>
    Effect.gen(function* () {
      const target = yield* toolsTarget(host, localServer, { fresh: false });
      const { callTool, printJson } = yield* toolsClient;
      const { pausedSession, recordPause } = yield* pausedCalls;
      const session =
        resumed === undefined ? Option.none() : yield* pausedSession(target.host, resumed);
      const result = yield* callTool(target, tool, input, Option.getOrUndefined(session));
      yield* recordPause(target.host, result.value, result.session, resumed);
      yield* printJson(result.value);
    });
  const loginHost = Flag.String("host").pipe(
    Flag.withDescription(
      `Executor origin to sign in to. Defaults to EXECUTOR_HOST, then hosted Executor, ${hostedExecutorOrigin}`,
    ),
    Flag.withFallbackConfig(Config.String("EXECUTOR_HOST")),
    Flag.withDefault(hostedExecutorOrigin),
  );
  return [
    Command.make("login", { host: loginHost }).pipe(
      Command.withDescription(
        "Sign in to a host for the tool commands and executor mcp, with a code approved in any browser. Choose which apps the sign-in reaches and how approvals are answered on the approval page. Later commands use this host by default",
      ),
      Command.withExamples([
        { command: "executor login", description: "Sign in to hosted Executor" },
        {
          command: "executor login --host https://executor.example.com",
          description: "Sign in to a self-hosted Executor",
        },
      ]),
      Command.withHandler(({ host }) =>
        Effect.gen(function* () {
          const session = yield* toolsLogin(host, platform);
          const { describeAccess, whoami } = yield* toolsClient;
          const target = {
            host,
            url: session.resource,
            token: Effect.succeed(Redacted.make(session.accessToken)),
            local: false,
          };
          // A host released before whoami still signs in; it just cannot say more. Any other
          // failure to describe the new sign-in is reported.
          const known = yield* whoami(target).pipe(
            Effect.map(Option.some),
            Effect.catchTag("WhoamiUnavailable", () => Effect.succeedNone),
          );
          yield* Option.match(known, {
            onNone: () => Console.log(`Connected to ${host}.`),
            onSome: ({ organization, access, mode }) =>
              Console.log(
                `Connected to ${host}${organization === null ? "" : ` as @${organization.slug}`}: ${describeAccess(access)}, approvals in ${mode} mode.`,
              ),
          });
        }),
      ),
    ),
    Command.make("logout", { host: hostFlag }).pipe(
      Command.withDescription(
        "Remove this CLI's sign-ins for a host, for tools and for app commands, and stop using it by default",
      ),
      Command.withHandler(({ host }) =>
        Effect.gen(function* () {
          const named = yield* namedHost(host);
          if (Option.isNone(named)) return yield* new ToolsSignInRequired({});
          const held = yield* logout(named.value);
          yield* Console.log(
            held ? `Signed out of ${named.value}.` : `Not signed in to ${named.value}.`,
          );
        }),
      ),
    ),
    Command.make("whoami", { host: hostFlag }).pipe(
      Command.withDescription(
        "Print the host, its organization, what the tools sign-in reaches and how its approvals are answered, and whether app commands are signed in, as JSON",
      ),
      Command.withHandler(({ host }) =>
        Effect.gen(function* () {
          const named = yield* namedHost(host);
          if (Option.isNone(named)) return yield* new ToolsSignInRequired({});
          const target = yield* toolsTarget<never, never>(named, undefined, { fresh: false });
          const { printJson, whoami } = yield* toolsClient;
          const known = yield* whoami(target);
          yield* printJson({
            host: target.host,
            mcp: target.url,
            ...Schema.encodeSync(McpWhoami)(known),
            apps: yield* hasRegistrySession(target.host),
          });
        }),
      ),
    ),
    Command.make("search", {
      host: hostFlag,
      query: Argument.String("query").pipe(
        Argument.withDescription(
          "Words matched against tool paths, descriptions, input names, and app, account and router labels. Omit it to list a namespace",
        ),
        Argument.optional,
      ),
      namespace: Flag.String("namespace").pipe(
        Flag.withDescription(
          "App slug, such as axiom, or a namespace inside it, such as acme.issues",
        ),
        Flag.optional,
      ),
      limit: Flag.Int("limit").pipe(
        Flag.withDescription("Most items to return; a page ends sooner at its size budget"),
        Flag.optional,
      ),
      offset: Flag.Int("offset").pipe(
        Flag.withDescription("Matches to skip, from a previous page's next.offset"),
        Flag.optional,
      ),
    }).pipe(
      Command.withDescription(`Find app tools and their exact paths and input types. ${prints}`),
      Command.withExamples([
        { command: 'executor search "github issues"', description: "Find tools by words" },
        { command: "executor search --namespace github", description: "List one app's tools" },
      ]),
      Command.withHandler(({ host, query, namespace, limit, offset }) =>
        run(host, "search", {
          ...Option.match(query, { onNone: () => ({}), onSome: (query) => ({ query }) }),
          ...Option.match(namespace, {
            onNone: () => ({}),
            onSome: (namespace) => ({ namespace }),
          }),
          ...Option.match(limit, { onNone: () => ({}), onSome: (limit) => ({ limit }) }),
          ...Option.match(offset, { onNone: () => ({}), onSome: (offset) => ({ offset }) }),
        }),
      ),
    ),
    Command.make("describe", {
      host: hostFlag,
      paths: Argument.String("path").pipe(
        Argument.withDescription("Exact tool paths from executor search, at most 20"),
        Argument.atLeast(1),
      ),
    }).pipe(
      Command.withDescription(
        `Print the whole description and TypeScript signature of tools at exact paths. ${prints}`,
      ),
      Command.withHandler(({ host, paths }) => run(host, "describe", { paths })),
    ),
    Command.make("call", {
      host: hostFlag,
      path: Argument.String("path").pipe(
        Argument.withDescription(
          "Exact tool path from executor search. Omit it to pass a JSON array of {path, input} calls as the input, which run concurrently",
        ),
        Argument.optional,
      ),
      input: Flag.String("input").pipe(
        Flag.withDescription("The tool's input as JSON. Default: {}"),
        Flag.optional,
      ),
      inputFile: fileFlag(
        "input-file",
        "Read the input JSON from this file, or from standard input with -",
      ),
    }).pipe(
      Command.withDescription(
        `Call app tools directly. Use executor execute when one result feeds another, or to keep only part of a large result. ${pauses}`,
      ),
      Command.withExamples([
        {
          command:
            'executor call tools.github.issues.list --input \'{"repo":"acme/web"}\' > issues.json',
          description: "Call one tool and keep its result in a file",
        },
        {
          command: "executor call --input-file calls.json",
          description: "Run a JSON array of {path, input} calls concurrently",
        },
        {
          command:
            "jq -n '{repo:\"acme/web\"}' | executor call tools.github.issues.list --input-file -",
          description: "Read the input from standard input",
        },
      ]),
      Command.withHandler(({ host, path, input, inputFile }) =>
        Effect.gen(function* () {
          const json = yield* jsonFrom(input, inputFile, "--input and --input-file", "The input");
          if (Option.isSome(path))
            return yield* run(host, "call", {
              calls: { path: path.value, input: Option.getOrElse(json, () => ({})) },
            });
          if (Option.isNone(json) || !Array.isArray(json.value))
            return yield* new ToolInputInvalid({
              message:
                "Pass a tool path, or a JSON array of {path, input} calls with --input or --input-file.",
            });
          return yield* run(host, "call", { calls: json.value });
        }),
      ),
    ),
    Command.make("execute", {
      host: hostFlag,
      code: Flag.String("code").pipe(
        Flag.withDescription("The JavaScript program to run"),
        Flag.optional,
      ),
      file: fileFlag("file", "Read the program from this file, or from standard input with -"),
    }).pipe(
      Command.withDescription(
        `Run a JavaScript program over your apps, where app tools are async functions such as tools.github.issues.list(input); return only what you need. ${pauses}`,
      ),
      Command.withExamples([
        {
          command: "executor execute --code 'return await tools.search({ query: \"github\" })'",
          description: "Search for tools inside a program",
        },
        {
          command: "executor execute --file program.js > result.json",
          description: "Run a program from a file and keep its result in a file",
        },
      ]),
      Command.withHandler(({ host, code, file }) =>
        Effect.gen(function* () {
          const program = yield* textFrom(code, file, "--code and --file");
          if (Option.isNone(program))
            return yield* new ToolInputInvalid({
              message: "Pass the program with --code, or with --file (- reads standard input).",
            });
          return yield* run(host, "execute", { code: program.value });
        }),
      ),
    ),
    Command.make("resume", {
      host: hostFlag,
      requestId: Argument.String("request-id").pipe(
        Argument.withDescription("The requestId of the paused call or program"),
      ),
      action: Flag.Literals("action", ["accept", "decline", "cancel"]).pipe(
        Flag.withDescription(
          "The person's answer. Required unless approvals are answered in the browser, where it is collected from the approvalUrl page",
        ),
        Flag.optional,
      ),
      content: Flag.String("content").pipe(
        Flag.withDescription("Form fields for accept, as a JSON object"),
        Flag.optional,
      ),
      contentFile: fileFlag(
        "content-file",
        "Read the form fields JSON from this file, or from standard input with -",
      ),
    }).pipe(
      Command.withDescription(
        `Continue a paused call or program with the person's answer; never run it again instead. ${pauses}`,
      ),
      Command.withExamples([
        { command: "executor resume apr_… --action accept", description: "Approve a paused call" },
        {
          command: "executor resume apr_…",
          description: "Collect an answer given on the approvalUrl page",
        },
      ]),
      Command.withHandler(({ host, requestId, action, content, contentFile }) =>
        Effect.gen(function* () {
          const fields = yield* jsonFrom(
            content,
            contentFile,
            "--content and --content-file",
            "The content",
          );
          if (Option.isNone(action)) {
            if (Option.isSome(fields))
              return yield* new ToolInputInvalid({ message: "Pass --action with --content." });
            return yield* run(host, "resume", { requestId }, requestId);
          }
          return yield* run(
            host,
            "resume",
            {
              requestId,
              response: {
                action: action.value,
                ...Option.match(fields, { onNone: () => ({}), onSome: (content) => ({ content }) }),
              },
            },
            requestId,
          );
        }),
      ),
    ),
    Command.make("skills", {
      host: hostFlag,
      app: Flag.String("app").pipe(
        Flag.withDescription("App slug. Omit it to list every visible skill"),
        Flag.optional,
      ),
      name: Flag.String("name").pipe(
        Flag.withDescription("Skill to read, such as executor. Requires --app"),
        Flag.optional,
      ),
      file: Flag.String("file").pipe(
        Flag.withDescription("File within the skill to read instead of SKILL.md. Requires --name"),
        Flag.optional,
      ),
      version: Flag.String("version").pipe(
        Flag.withDescription("App version to read the skill from, instead of the active one"),
        Flag.optional,
      ),
      revision: Flag.String("revision").pipe(
        Flag.withDescription("Skill revision a previous read returned, to read that exact copy"),
        Flag.optional,
      ),
    }).pipe(
      Command.withDescription(
        `List or read the skills apps ship. Start with --app executor --name executor. ${prints}`,
      ),
      Command.withHandler(({ host, ...input }) =>
        run(
          host,
          "skills",
          Object.fromEntries(
            Object.entries(input).flatMap(([key, value]) =>
              Option.isSome(value) ? [[key, value.value]] : [],
            ),
          ),
        ),
      ),
    ),
    Command.make("mcp", { host: hostFlag }).pipe(
      Command.withDescription(
        "Serve the resolved host's MCP endpoint over stdio, with this CLI's sign-in, for MCP clients such as `claude mcp add executor -- executor mcp`",
      ),
      Command.withHandler(({ host }) =>
        toolsTarget(host, localServer, { fresh: true }).pipe(
          Effect.flatMap((target) => Effect.flatMap(toolsClient, ({ relay }) => relay(target))),
        ),
      ),
    ),
  ];
};
