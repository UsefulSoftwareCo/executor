/** Local launcher behavior. Runtime process APIs are supplied only at entry points. */
import { Console, Effect, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { LocalAuthApi } from "../contracts/auth.ts";
import { localConfiguration } from "./bootstrap.ts";
import { StartupFailed, type LaunchMode } from "../contracts/startup.ts";
import { readDesktopBootstrap, startLocalServer } from "../node.ts";

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

/** Start headless/browser/desktop using one server; pairing an existing server never opens storage. */
export const launch = (mode: LaunchMode, platform: string) =>
  Effect.gen(function* () {
    const settings = yield* localConfiguration(platform);
    if (mode === "pair") {
      const client = yield* HttpApiClient.make(LocalAuthApi, {
        baseUrl: `http://127.0.0.1:${settings.port}`,
        transformClient: (client) =>
          client.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(settings.apiKey))),
      }).pipe(Effect.provide(FetchHttpClient.layer));
      const link = yield* client.auth
        .pair()
        .pipe(Effect.mapError(() => new StartupFailed({ stage: "pair" })));
      return yield* Console.log(Redacted.value(link.url));
    }
    const bootstrap = mode === "desktop" ? yield* readDesktopBootstrap : undefined;
    const server = yield* startLocalServer(settings, bootstrap);
    if (mode === "desktop") {
      // A desktop parent parses this readiness line before opening its renderer.
      // Its bootstrap credential came through fd3 and is never echoed here.
      yield* Console.log(JSON.stringify({ version: 1, url: server.url }));
    } else {
      const link = yield* server.issuePairingLink;
      yield* Console.log(
        `Executor: ${server.url}\nMCP: ${server.url}/mcp\nConnect (one use, expires in 5 minutes):\n${Redacted.value(link.url)}`,
      );
      if (mode === "browser")
        yield* openBrowser(link.url, platform).pipe(
          Effect.catch(() => Console.log("Open the connection link above in your browser.")),
        );
    }
    yield* Effect.never;
  });
