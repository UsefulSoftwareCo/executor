/** Local launcher behavior. Runtime process APIs are supplied only at entry points. */
import { Config, Console, Effect, Option, Redacted } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { localConfiguration } from "./bootstrap.ts";
import { StartupFailed, type LaunchMode } from "../contracts/startup.ts";
import { readDesktopBootstrap, startLocalServer } from "../node.ts";
import { recordServer } from "./server-record.ts";
import { updateNotice } from "./update-notice.ts";

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
 * Start headless/browser/desktop using one server. Pairing with a running server is `pair.ts`.
 * `entry` is the script Node started, which tells the update notice how the CLI was installed.
 */
export const launch = (mode: LaunchMode, platform: string, entry?: string) =>
  Effect.gen(function* () {
    const settings = yield* localConfiguration(platform);
    const bootstrap = mode === "desktop" ? yield* readDesktopBootstrap : undefined;
    const server = yield* startLocalServer(settings, bootstrap, {
      product: mode === "desktop" ? "desktop" : "cli",
    });
    if (mode === "desktop") {
      // A desktop parent parses this readiness line before opening its renderer.
      // Its bootstrap credential came through fd3 and is never echoed here.
      yield* Console.log(JSON.stringify({ version: 1, url: server.url }));
    } else {
      const link = yield* server.issuePairingLink;
      const origin = settings.browserOrigin ?? server.url;
      yield* Console.log(
        `Executor: ${origin}\nMCP: ${origin}/mcp\nConnect (one use, expires in 5 minutes):\n${Redacted.value(link.url)}`,
      );
      if (mode === "browser")
        yield* openBrowser(link.url, platform).pipe(
          Effect.catch(() => Console.log("Open the connection link above in your browser.")),
        );
      // `executor upgrade` reads this record to say that this server needs restarting.
      yield* recordServer(settings.directory, {
        pid: process.pid,
        // What `executor --version` prints; development builds have none.
        version: Option.getOrUndefined(
          yield* Config.String("EXECUTOR_BUILD_VERSION").pipe(Config.option),
        ),
        url: origin,
        command: mode === "browser" ? "executor" : "executor serve",
      });
      yield* Effect.forkScoped(updateNotice(settings.directory, entry));
    }
    return yield* Effect.never;
  });
