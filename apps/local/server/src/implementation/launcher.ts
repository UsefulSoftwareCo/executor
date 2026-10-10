/** Local launcher behavior. Runtime process APIs are supplied only at entry points. */
import { Console, Effect, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { LocalAuthApi } from "../contracts/auth.ts";
import { LocalConfigurationError, localConfiguration, savedConfiguration } from "./bootstrap.ts";
import { StartupFailed, type LaunchMode } from "../contracts/startup.ts";
import { readDesktopBootstrap, startLocalServer } from "../node.ts";
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
 * Start headless/browser/desktop using one server; pairing an existing server never opens storage.
 * `installation` is the running CLI's own file, which tells the update notice how it was installed.
 */
export const launch = (mode: LaunchMode, platform: string, installation?: string) =>
  Effect.gen(function* () {
    if (mode === "pair") {
      const failed = () => Effect.fail(new StartupFailed({ stage: "pair" }));
      const settings = yield* savedConfiguration(platform);
      const client = yield* HttpApiClient.make(LocalAuthApi, {
        baseUrl: `http://127.0.0.1:${settings.port}`,
        transformClient: (client) =>
          client.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(settings.apiKey))),
      }).pipe(Effect.provide(FetchHttpClient.layer));
      const link = yield* client.auth.pair().pipe(
        Effect.catchTags({
          PairingUnauthorized: () =>
            Effect.fail(
              new LocalConfigurationError({
                reason: "misconfigured",
                message: `The server on 127.0.0.1:${settings.port} did not accept the API key for ${settings.directory}. It probably uses another data directory: set EXECUTOR_DATA_DIR to the folder it uses. Nothing was changed.`,
              }),
            ),
          HttpClientError: (error) =>
            Effect.fail(
              error.reason._tag === "TransportError"
                ? new LocalConfigurationError({
                    reason: "io",
                    message: `No Executor server answered on 127.0.0.1:${settings.port}. Start Executor first, or set EXECUTOR_PORT to the port it listens on. Nothing was changed.`,
                  })
                : new StartupFailed({ stage: "pair" }),
            ),
          AuthForbidden: failed,
          AuthStorageError: failed,
          SchemaError: failed,
        }),
      );
      return yield* Console.log(Redacted.value(link.url));
    }
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
      yield* Effect.forkScoped(updateNotice(settings.directory, installation));
    }
    return yield* Effect.never;
  });
