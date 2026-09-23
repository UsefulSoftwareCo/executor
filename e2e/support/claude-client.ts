/** Drive the real interactive CLI. Claude owns MCP discovery, PKCE, tokens and its loopback callback. */
import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { Key } from "@kitlangton/terminal-control";
import { Evidence } from "./evidence.ts";
import { Target } from "./platform.ts";
import { Terminal } from "./terminal.ts";

class ClaudeFailed extends Schema.TaggedError<ClaudeFailed>()("ClaudeFailed", {
  operation: Schema.String,
}) {
  get message() {
    return this.operation;
  }
}
class BrowserPending extends Schema.TaggedError<BrowserPending>()("BrowserPending", {}) {}
const make = Effect.gen(function* () {
  const target = yield* Target,
    evidence = yield* Evidence,
    terminal = yield* Terminal;
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = yield* Config.String("E2E_CLAUDE_COMMAND").pipe(Config.withDefault("claude"));
  const model = yield* Config.String("E2E_CLAUDE_MODEL").pipe(
    Config.withDefault("claude-sonnet-4-6"),
  );
  const baseUrl = yield* Config.String("E2E_CLAUDE_BASE_URL").pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.String.check(
          Schema.makeFilter(
            (value) => {
              const url = URL.parse(value);
              return (
                url !== null &&
                url.origin === value &&
                (url.protocol === "https:" ||
                  (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))
              );
            },
            { message: "E2E_CLAUDE_BASE_URL must be an HTTPS origin or an HTTP loopback origin." },
          ),
        ),
      ),
    ),
  );
  const apiKey = yield* Config.Redacted("E2E_CLAUDE_API_KEY"),
    executablePath = yield* Config.String("PATH");
  return {
    start: Effect.gen(function* () {
      const version = (yield* processes.string(ChildProcess.make(command, ["--version"]))).trim();
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: target.directory,
        prefix: "claude-",
      });
      const config = `${directory}/mcp.json`,
        request = `${directory}/browser.json`;
      yield* fs.writeFileString(
        config,
        JSON.stringify({
          mcpServers: {
            executor_e2e: { type: "http", url: `${target.metadata.origin}/mcp` },
          },
        }),
        { mode: 0o600 },
      );
      yield* fs.makeDirectory(`${directory}/bin`, { mode: 0o700 });
      const opener = `#!/usr/bin/env node\nimport ${JSON.stringify(path.resolve("e2e/browser-open.ts"))};\n`;
      for (const name of ["open", "xdg-open"])
        yield* fs.writeFileString(`${directory}/bin/${name}`, opener, { mode: 0o700 });
      const session = yield* terminal.launch("Claude Code", {
        command: [
          command,
          "--bare",
          "--model",
          model,
          "--effort",
          "low",
          "--setting-sources",
          "",
          "--strict-mcp-config",
          "--mcp-config",
          config,
          "--tools",
          "",
          "--allowedTools",
          "mcp__executor_e2e__execute",
          "--permission-mode",
          "manual",
          "--no-chrome",
          "--system-prompt",
          "Use the configured Executor MCP server for the requested test. Report tool errors honestly.",
        ],
        cwd: directory,
        inheritEnv: false,
        viewport: { cols: 110, rows: 36 },
        env: {
          PATH: `${directory}/bin:${executablePath}`,
          TERM: "xterm-256color",
          CLAUDE_CONFIG_DIR: directory,
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: Redacted.value(apiKey),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          BROWSER: `${directory}/bin/open`,
          E2E_BROWSER_ORIGIN: target.metadata.origin,
          E2E_BROWSER_REQUEST: request,
        },
      });
      const wait = (label: string, text: string | RegExp, timeoutMs = 20000) =>
        session.use(label, (session) => session.screen.waitForText(text, { timeoutMs }));
      const keys = (label: string, keys: ReadonlyArray<Key>) =>
        Effect.forEach(
          keys,
          (key) =>
            Effect.gen(function* () {
              yield* session.use(`Wait for ${label.toLowerCase()}`, (session) =>
                session.screen.waitForIdle({ quietForMs: 250, timeoutMs: 5000 }),
              );
              yield* session.use(label, (session) => session.keyboard.press(key));
            }),
          { discard: true },
        );
      yield* wait("Claude opens its first-run setup", "Choose the text style");
      yield* keys("Choose the terminal theme", ["Enter"]);
      yield* wait("Claude detects the configured model API", "Do you want to use this API key?");
      yield* keys("Select the configured VibeProxy API", ["ArrowUp"]);
      yield* wait("The API key choice is selected", /❯\s+Yes/);
      yield* keys("Use the configured VibeProxy API", ["Enter"]);
      yield* wait("Read Claude's security notes", "Security notes:");
      yield* keys("Continue to the isolated workspace", ["Enter"]);
      yield* wait("Claude asks to trust the test workspace", "Yes, I trust this folder");
      yield* keys("Select the isolated workspace", ["ArrowDown"]);
      yield* wait("The trust choice is selected", /❯\s+Yes, I trust this folder/);
      yield* keys("Trust this isolated synthetic workspace", ["Enter"]);
      yield* wait("Claude is ready for commands", "manual mode on");
      yield* evidence.json("claude-client.json", {
        version,
        model,
        modelApi: baseUrl,
        target: target.metadata.origin,
        mode: "interactive",
        permissionMode: "manual",
        builtInTools: [],
        oauth: "Claude /mcp browser authentication",
        injectedMcpTokens: false,
      });
      return {
        requestConnection: Effect.gen(function* () {
          yield* session.use("Type /mcp in Claude Code", (session) =>
            session.keyboard.type("/mcp"),
          );
          yield* keys("Open Claude's MCP menu", ["Enter"]);
          yield* wait(
            "Claude lists the unauthenticated server",
            /executor_e2e.*needs authentication/,
          );
          yield* keys("Open the Executor server", ["Enter"]);
          yield* wait("Claude offers authentication", "1. Authenticate");
          yield* keys("Authenticate from Claude Code", ["Enter"]);
          const launch = yield* Effect.gen(function* () {
            if (!(yield* fs.exists(request))) return yield* new BrowserPending();
            return yield* fs.readFileString(request).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
                ),
              ),
              Effect.mapError(
                () => new ClaudeFailed({ operation: "Invalid browser launch request" }),
              ),
            );
          }).pipe(
            Effect.retry({
              while: (error) => error instanceof BrowserPending,
              schedule: Schedule.spaced("50 millis"),
              times: 600,
            }),
            Effect.mapError(
              () =>
                new ClaudeFailed({
                  operation: "Claude did not request its authentication browser",
                }),
            ),
          );
          const url = URL.parse(launch.url),
            clientId = url?.searchParams.get("client_id");
          const callback = url ? URL.parse(url.searchParams.get("redirect_uri") ?? "") : null;
          if (
            !url ||
            url.origin !== target.metadata.origin ||
            url.pathname !== "/api/auth/oauth2/authorize" ||
            !clientId ||
            !callback
          )
            return yield* new ClaudeFailed({
              operation: "Claude opened an unexpected authorization request",
            });
          yield* wait(
            "Claude waits for browser authentication",
            "Authenticating with executor_e2e",
          );
          yield* evidence.json("claude-browser-launch.json", {
            origin: url.origin,
            path: url.pathname,
            clientId,
            pkce: url.searchParams.get("code_challenge_method"),
            callback: callback.origin,
          });
          return { url: Redacted.make(url.href), clientId };
        }),
        finishConnection: Effect.gen(function* () {
          yield* wait(
            "Return to Claude and verify the authenticated connection",
            "Authentication successful. Connected to executor_e2e.",
            45000,
          );
          yield* wait("Claude is ready to use Executor", "manual mode on");
          const screen = yield* session.use("Capture Claude's authenticated prompt", (session) =>
            session.screen.text(),
          );
          yield* evidence.attach("claude-connected.txt", "text/plain", screen);
        }),
        invoke: (appName: string, receipt: string) =>
          Effect.gen(function* () {
            const prompt = `Use executor_e2e's execute tool to discover the app ${JSON.stringify(appName)} with tools.search. Invoke its echo tool with {"message":"from Claude Code"}. Print the exact returned JSON, including its receipt. Do not invent results or use any other app.`;
            yield* session.use("Ask Claude to discover and invoke the app", (session) =>
              session.keyboard.type(prompt),
            );
            yield* keys("Run the request in this authenticated session", ["Enter"]);
            yield* wait("Claude displays the real tool receipt", receipt, 90000);
            yield* session.use("Wait for Claude's completed response", (session) =>
              session.screen.waitForIdle({ quietForMs: 500, timeoutMs: 10000 }),
            );
            return yield* session.use("Read Claude's tool result", (session) =>
              session.screen.text(),
            );
          }),
      };
    }),
  };
});
/** An isolated interactive client with model API access and no preauthorized Executor credentials. */
export class ClaudeClient extends Context.Service<ClaudeClient, Effect.Success<typeof make>>()(
  "e2e/ClaudeClient",
) {
  static readonly layer = Layer.effect(ClaudeClient, make);
}
