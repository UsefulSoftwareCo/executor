/**
 * `executor`: start or join the background server, pair a browser with it, print where Executor
 * runs, open the dashboard and exit. `--standalone`, or the service's `disabled` setting, runs a
 * private server that stays in the foreground until interrupted, or fails once that server stops,
 * instead; `--server` uses a server that is already running elsewhere. Runtime process APIs are
 * supplied only at entry points.
 */
import { Console, Duration, Effect, Fiber, Option, Redacted } from "effect";
import { CliError } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ServiceFailed } from "../contracts/service.ts";
import { StartupFailed } from "../contracts/startup.ts";
import { savedApiKey, withKeyFileNotice } from "./bootstrap.ts";
import { pairingLink, serverOrigins } from "./pair.ts";
import { ensure, standalone } from "./service-client.ts";
import { readSettings, serviceDirectory } from "./service-files.ts";
import { updateNotice } from "./update-notice.ts";

/** How long a finished command still waits for the daily release check before it exits. */
const noticeWait = Duration.seconds(2);

const openBrowser = (url: Redacted.Redacted<string>, platform: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command =
      platform === "darwin"
        ? ChildProcess.make("open", [Redacted.value(url)])
        : platform === "win32"
          ? ChildProcess.make("rundll32", ["url.dll,FileProtocolHandler", Redacted.value(url)])
          : ChildProcess.make("xdg-open", [Redacted.value(url)]);
    const code = yield* spawner.exitCode(command);
    if (code !== 0) return yield* new StartupFailed({ stage: "browser" });
  }).pipe(Effect.mapError(() => new StartupFailed({ stage: "browser" })));

/**
 * `--server`: a connection link from a server that runs elsewhere, sent EXECUTOR_API_KEY or the
 * key saved in the data directory.
 */
const viaServer = (server: string, platform: string) =>
  Effect.gen(function* () {
    if (!/^https?:\/\//u.test(server) || !URL.canParse(server))
      return yield* new CliError.UserError({
        cause: `--server must be an http:// or https:// URL, such as http://127.0.0.1:4312, not ${server}.`,
      });
    const url = server.replace(/\/+$/u, "");
    const { directory, apiKey, keys } = yield* savedApiKey(platform);
    return yield* pairingLink({ url, credential: apiKey, directory, keys }).pipe(
      Effect.catchIf(
        (error) => error.reason === "no-server",
        () => Effect.fail(new ServiceFailed({ reason: "unreachable", detail: url })),
      ),
    );
  });

/**
 * A connection link from this data directory's background server, started or replaced by this
 * version if needed, or from a private server for this command, with what fails once that private
 * server stops. The link must point at that server or its HTTPS browser origin.
 */
const ownServer = (directory: string, foreground: boolean) =>
  Effect.gen(function* () {
    const server = foreground
      ? yield* standalone
      : {
          ...(yield* withKeyFileNotice(directory, ensure(directory, { version: "replace" }))),
          exited: undefined,
        };
    const link = yield* pairingLink({
      url: server.url,
      credential: server.password,
      directory,
      keys: "registered",
      origins: serverOrigins(server.url, server.browserOrigin),
    });
    return { link, exited: server.exited };
  });

export interface LaunchOptions {
  readonly standalone: boolean;
  readonly server: Option.Option<string>;
}

/**
 * Pair a browser with the server this invocation uses. `entry` is the file that started the CLI,
 * which tells the update notice how it was installed.
 */
export const launch = (options: LaunchOptions, platform: string, entry: string | undefined) =>
  Effect.gen(function* () {
    if (options.standalone && Option.isSome(options.server))
      return yield* new CliError.UserError({ cause: "Use --standalone or --server, not both." });
    const directory = yield* serviceDirectory;
    // The daily release check runs beside startup; it never fails or holds the command for long.
    const notice = yield* Effect.forkScoped(updateNotice(directory, entry));
    const foreground =
      Option.isNone(options.server) &&
      (options.standalone || (yield* readSettings(directory)).disabled === true);

    const { link, exited } = Option.isSome(options.server)
      ? { link: yield* viaServer(options.server.value, platform), exited: undefined }
      : yield* ownServer(directory, foreground);

    const origin = new URL(Redacted.value(link.url)).origin;
    yield* Console.log(
      `Executor: ${origin}\nMCP: ${origin}/mcp\nConnect (one use, expires in 5 minutes):\n${Redacted.value(link.url)}`,
    );
    yield* openBrowser(link.url, platform).pipe(
      Effect.catch(() => Console.log("Open the connection link above in your browser.")),
    );
    // A private server lives as long as this command, which fails if it stops first; the
    // background server outlives it.
    if (exited !== undefined) return yield* exited;
    yield* Fiber.join(notice).pipe(Effect.timeout(noticeWait), Effect.ignore);
  });
