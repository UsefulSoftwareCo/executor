import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Cause,
  Clock,
  Config,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { _electron, chromium } from "playwright";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { strFromU8, unzipSync } from "fflate";
import { driver } from "../support/platform.ts";
import { freePort } from "../support/ports.ts";
import {
  desktopCli,
  desktopEvents,
  eventsNamed,
  requestBrowserPairing,
  runnerSession,
  stopBackgroundServers,
} from "../support/desktop.ts";
import { captureOutput, closeDesktop, closeLimit, quitBound } from "../support/desktop-quit.ts";
import { authorizeBrowserMcp } from "../support/mcp-oauth.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Collector, SpanQuery } from "../support/contracts.ts";
import { withApps } from "../support/apps-release.ts";
import { localNpmRegistry } from "../support/npm-registry.ts";

it.live("packaged desktop starts without the workspace and retains apps after restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const executablePath = yield* Config.String("EXECUTOR_E2E_DESKTOP_EXECUTABLE");
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-desktop-artifact-" });
      yield* fs.makeDirectory(".local/releases", { recursive: true });
      const apiKey = randomBytes(32).toString("hex");
      const encryptionKey = randomBytes(32).toString("hex");
      const runtimePath = yield* Config.String("EXECUTOR_E2E_RUNTIME_PATH").pipe(
        Config.withDefault(process.env.PATH ?? ""),
      );
      const port = yield* freePort;
      // The desktop server deploys the bundled Executor app, which pins this checkout's apps release.
      const registry = yield* localNpmRegistry;
      const origin = `http://127.0.0.1:${port}`;
      const mcpUrl = new URL(`${origin}/mcp`);
      // The backend keeps its compile cache in the OS per-user cache directory, pointed here.
      const cacheHome = path.join(directory, "cache-home");
      const cache = path.join(
        process.platform === "darwin" ? path.join(cacheHome, "Library", "Caches") : cacheHome,
        "executor",
        "v2",
        "compile-cache",
      );
      const data = path.join(directory, "data");
      const env = {
        ...runnerSession(),
        PATH: runtimePath,
        HOME: process.platform === "darwin" ? cacheHome : (process.env.HOME ?? ""),
        ...(process.platform === "win32"
          ? { LOCALAPPDATA: cacheHome }
          : process.platform === "darwin"
            ? {}
            : { XDG_CACHE_HOME: cacheHome }),
        // Release scenarios never send product analytics, even from a build with a baked key.
        DO_NOT_TRACK: "1",
        EXECUTOR_API_KEY: apiKey,
        EXECUTOR_ENCRYPTION_KEY: encryptionKey,
        EXECUTOR_PORT: String(port),
        EXECUTOR_DESKTOP_DATA_DIR: data,
        EXECUTOR_DESKTOP_PROFILE_DIR: path.join(directory, "profile"),
        EXECUTOR_NPM_REGISTRY: registry.url,
      };
      // The background server outlives the desktop; the scope stops it before removing its data.
      yield* Effect.addFinalizer(() => stopBackgroundServers(data, () => []));
      // The CLI the desktop staged out of the app, on the desktop's data.
      const cli = yield* desktopCli({ env: { ...env, EXECUTOR_DATA_DIR: data }, cwd: directory });
      let appId = "";
      let appSlug = "";
      let appUiUrl: string | undefined;
      let oauthToken: Redacted.Redacted<string> | undefined;
      const diagnostics: string[] = [];
      /**
       * The desktop's and its background server's logs, as last read on a failure. Every later
       * write keeps them, since the data directory that holds them is removed with the scope.
       */
      let savedLogs: ReadonlyArray<string> = [];
      const writeLog = Effect.suspend(() =>
        fs.writeFileString(
          ".local/releases/desktop-test.log",
          [...diagnostics, ...savedLogs].join(""),
          { mode: 0o600 },
        ),
      );
      // Each checkpoint is saved at once, so a run that hangs still shows how far it got.
      const checkpoint = (stage: string) =>
        Effect.sync(() => {
          diagnostics.push(
            `${JSON.stringify({ checkpoint: stage, at: new Date().toISOString() })}\n`,
          );
        }).pipe(Effect.andThen(writeLog.pipe(Effect.ignore)));
      yield* Effect.addFinalizer(() => writeLog.pipe(Effect.orDie));
      const browser = yield* Effect.acquireRelease(
        driver("launch an independent browser", () => chromium.launch()),
        (browser) => driver("close independent browser", () => browser.close()).pipe(Effect.orDie),
      );
      for (const first of [true, false]) {
        yield* checkpoint(first ? "Verify first desktop launch" : "Verify desktop restart");
        yield* Effect.scoped(
          Effect.gen(function* () {
            // Its stderr is captured from launch, for the close to keep if it does not finish.
            const { electron } = yield* Effect.acquireRelease(
              driver("launch packaged desktop", () =>
                // Hosted runners have no usable GPU. Exercise the packaged app
                // with software rendering instead of repeated GPU startup failures.
                _electron.launch({ executablePath, cwd: directory, env, args: ["--disable-gpu"] }),
              ).pipe(Effect.map((electron) => ({ electron, output: captureOutput(electron) }))),
              ({ electron, output }) => closeDesktop(electron, { data, output }).pipe(Effect.orDie),
            );
            const capture = (chunk: Uint8Array) =>
              diagnostics.push(new TextDecoder().decode(chunk));
            electron.process().stderr?.on("data", capture);
            // A launch that never pairs may hang its cleanup, so its logs are saved first: the
            // desktop's and its background server's, which the release workflow uploads.
            const saveLogs = fs.readDirectory(path.join(data, "diagnostics")).pipe(
              Effect.flatMap((names) =>
                Effect.forEach(
                  names.filter((name) => name.endsWith(".jsonl") || name === "collector.json"),
                  (name) =>
                    fs
                      .readFileString(path.join(data, "diagnostics", name))
                      .pipe(Effect.map((text) => `--- ${name}\n${text.slice(-200_000)}`)),
                ),
              ),
              Effect.catch((error) => Effect.succeed([`--- diagnostics unreadable: ${error}\n`])),
              Effect.flatMap((logs) =>
                Effect.sync(() => {
                  savedLogs = logs;
                }),
              ),
              Effect.andThen(writeLog),
              Effect.ignore,
            );
            // Closing the desktop is the last step, after this one, so a close that hangs still
            // leaves the failure and the logs behind.
            yield* Effect.addFinalizer((exit) =>
              Exit.isFailure(exit)
                ? Effect.sync(() =>
                    diagnostics.push(`--- failure\n${Cause.pretty(exit.cause)}\n`),
                  ).pipe(Effect.andThen(saveLogs))
                : Effect.void,
            );
            const page = yield* driver("desktop window", () => electron.firstWindow());
            yield* driver("desktop opens while its server starts", () =>
              page.getByRole("heading", { name: "Starting Executor", exact: true }).waitFor(),
            );
            if (first)
              yield* driver("capture desktop startup", () =>
                page.screenshot({ path: ".local/releases/desktop-startup.png" }),
              );
            yield* driver("paired dashboard", () =>
              page
                .getByRole("heading", { name: /^Apps/ })
                .waitFor({ state: "visible", timeout: 60_000 }),
            ).pipe(Effect.tapError(() => saveLogs));
            expect(new URL(page.url()).origin).toBe(origin);
            yield* checkpoint("Desktop dashboard ready");
            // Each page owns a fresh context, so restart still proves pairing from no session.
            const browserPage = yield* Effect.acquireRelease(
              driver("new unpaired browser", () => browser.newPage()),
              (page) => driver("close independent page", () => page.close()).pipe(Effect.orDie),
            );
            const initialSession = yield* driver("check unpaired browser", () =>
              browserPage.request.get(`${origin}/auth/session`).then((response) => response.json()),
            );
            expect(initialSession).toEqual({ authenticated: false });
            const pairing = yield* requestBrowserPairing(electron, origin);
            expect(pairing.status).toBe(200);
            const link = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ url: Schema.RedactedFromValue(Schema.String) }),
            )(pairing.body);
            yield* driver("open paired dashboard in independent browser", () =>
              browserPage.goto(Redacted.value(link.url)),
            );
            yield* driver("independent browser dashboard", () =>
              browserPage.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
            );
            const browserSession = yield* driver("check browser authentication", () =>
              browserPage.request.get(`${origin}/auth/session`).then((response) => response.json()),
            );
            expect(browserSession).toEqual({ authenticated: true });
            if (first) oauthToken = yield* authorizeBrowserMcp(browserPage, origin);
            yield* checkpoint("Independent browser paired with MCP authorization");
            if (oauthToken === undefined)
              return yield* Effect.fail(new Error("Missing saved MCP OAuth token"));
            const hasBrowserAction = yield* driver("find the native browser action", () =>
              electron.evaluate(
                ({ Menu }) =>
                  Menu.getApplicationMenu()?.items.some(
                    (item) =>
                      item.label === "File" &&
                      item.submenu?.items.some((action) => action.label === "Open in browser"),
                  ) === true,
              ),
            );
            expect(hasBrowserAction).toBe(true);
            yield* driver("capture the paired desktop", () =>
              page.screenshot({
                path: path.resolve(
                  `.local/releases/desktop-${process.platform}-${first ? "first" : "restart"}.png`,
                ),
              }),
            );
            const mcp = yield* Effect.acquireRelease(
              driver("create MCP client", () =>
                Promise.resolve(new Client({ name: "desktop-release", version: "1" })),
              ),
              (client) => driver("close MCP client", () => client.close()).pipe(Effect.orDie),
            );
            const transport: Omit<StreamableHTTPClientTransport, "sessionId"> =
              new StreamableHTTPClientTransport(mcpUrl, {
                requestInit: { headers: { authorization: `Bearer ${Redacted.value(oauthToken)}` } },
              });
            yield* driver("connect to the saved MCP URL", () => mcp.connect(transport));
            const tools = yield* driver("list tools at the saved MCP URL", () => mcp.listTools());
            expect(tools.tools.map((tool) => tool.name)).toContain("execute");
            if (first) {
              const response = yield* driver("deploy through packaged desktop", () =>
                page.request.post(`${origin}/v1/apps/deploy`, {
                  headers: { authorization: `Bearer ${apiKey}` },
                  data: {
                    owner: "local",
                    name: "Desktop verification",
                    files: [
                      {
                        path: "index.ts",
                        content: `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
import isNumber from "is-number";
const service = defineProvider({ name: "Desktop test service", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) }),
} });
export const check = (token: string) => query({ input: object({}) }, async () => ({
  numeric: isNumber("2"), connected: token === "synthetic-desktop-token",
}));
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts } }) => ({
  tools: router({ check: check(accounts.service.fields.token) }),
}));`,
                      },
                      {
                        path: "package.json",
                        content: JSON.stringify({
                          dependencies: withApps({
                            "is-number": "7.0.0",
                            react: "19.2.0",
                            "react-dom": "19.2.0",
                          }),
                        }),
                      },
                      {
                        path: "ui/index.html",
                        content:
                          '<!doctype html><html><head><title>Release app</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
                      },
                      {
                        path: "ui/main.tsx",
                        content: `import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { boolean, object } from "apps";
import { createAppClient, queryReference } from "apps/client";
import type { check } from "../index.ts";
const client = createAppClient();
function App() {
  const [status, setStatus] = useState("Loading");
  useEffect(() => {
    client.query(queryReference<ReturnType<typeof check>>("check"), {}, object({ numeric: boolean(), connected: boolean() }))
      .then((value) => setStatus(value.numeric && value.connected ? "Connected" : "Failed"))
      .catch(() => setStatus("Failed"));
  }, []);
  return <main><h1>Release app</h1><p role="status">{status}</p></main>;
}
const root = document.getElementById("root");
if (root === null) throw new Error("Missing root element");
createRoot(root).render(<App />);`,
                      },
                    ],
                  },
                }),
              );
              expect(response.status()).toBe(200);
              const deployed = yield* driver("deploy response", () => response.json());
              const created = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ app: Schema.Struct({ id: Schema.String, slug: Schema.String }) }),
              )(deployed);
              appId = created.app.id;
              appSlug = created.app.slug;
              const connectionResponse = yield* driver(
                "request a targeted account connection",
                () =>
                  page.request.post(`${origin}/account-connect/api/requests`, {
                    headers: { authorization: `Bearer ${apiKey}` },
                    data: {
                      owner: "local",
                      target: { app: appId, requirement: "service" },
                    },
                  }),
              );
              expect(
                connectionResponse.status(),
                yield* driver("connection response", () => connectionResponse.text()),
              ).toBe(200);
              const connection = yield* driver("read the connection link", () =>
                connectionResponse.json(),
              ).pipe(
                Effect.flatMap(
                  Schema.decodeUnknownEffect(
                    Schema.Struct({ connection: Schema.String, url: Schema.String }),
                  ),
                ),
              );
              const token = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
                new URLSearchParams(new URL(connection.url).hash.slice(1)).get("token"),
              );
              const account = yield* driver("connect the synthetic account", () =>
                page.request.post(`${origin}/account-connect/api/submit`, {
                  headers: { origin },
                  data: {
                    connection: connection.connection,
                    token,
                    method: "key",
                    label: "default",
                    fields: { token: "synthetic-desktop-token" },
                  },
                }),
              );
              expect(account.status()).toBe(200);
              // Connecting for the app links the account to it; calls use it.
              yield* checkpoint("Desktop app deployed with its account");
            }
            const detailResponse = yield* driver("read the private app address", () =>
              browserPage.request.get(`${origin}/dashboard/api/apps/${appId}`),
            );
            expect(detailResponse.status()).toBe(200);
            const detail = yield* driver("decode the private app address", () =>
              detailResponse.json(),
            ).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.Struct({ uiUrl: Schema.NonEmptyString })),
              ),
            );
            if (appUiUrl === undefined) appUiUrl = detail.uiUrl;
            expect(detail.uiUrl).toBe(appUiUrl);
            const bookmark = appUiUrl;
            yield* driver("open the bookmarked private app", () => browserPage.goto(bookmark));
            yield* driver("the app authenticates and renders React", () =>
              browserPage
                .getByRole("heading", { name: "Release app", exact: true })
                .waitFor({ state: "visible" }),
            );
            yield* driver("the app UI uses its connected account", () =>
              browserPage
                .getByRole("status")
                .filter({ hasText: /^Connected$/ })
                .waitFor({ state: "visible" }),
            );
            const execution = yield* driver("call the connected app through MCP OAuth", (signal) =>
              mcp.callTool(
                {
                  name: "execute",
                  arguments: {
                    code: `return await tools[${JSON.stringify(appSlug)}].check({})`,
                  },
                },
                undefined,
                { signal },
              ),
            );
            const completed = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                status: Schema.Literal("completed"),
                execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
              }),
            )(execution.structuredContent);
            expect(completed.execution.value).toEqual({ numeric: true, connected: true });
            yield* checkpoint("Private app and MCP execution verified");
            const traceId = randomBytes(16).toString("hex");
            const called = yield* driver("call retained app", () =>
              page.request.post(`${origin}/v1/tools/call`, {
                headers: {
                  authorization: `Bearer ${apiKey}`,
                  traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
                },
                data: {
                  app: appId,
                  tool: "check",
                  kind: "query",
                  input: {},
                },
              }),
            );
            expect(called.status()).toBe(200);
            const result = yield* driver("query response", () => called.json());
            expect(result).toEqual({
              status: "completed",
              value: { numeric: true, connected: true },
            });
            yield* Effect.gen(function* () {
              const collector = yield* fs
                .readFileString(path.join(directory, "data/diagnostics/collector.json"))
                .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Collector))));
              const spans = yield* driver("read the delivered tool-call trace", (signal) =>
                fetch(`${collector.url}/api/traces/${traceId}/spans`, { signal }).then((response) =>
                  response.json(),
                ),
              ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SpanQuery)));
              if (
                !spans.data.some(
                  (entry) =>
                    entry.traceId === traceId &&
                    entry.span.serviceName === "executor-local" &&
                    entry.span.tags["http.response.status_code"] === "200",
                )
              )
                return yield* Effect.fail(
                  new Error("The actual tool-call trace must reach the collector"),
                );
            }).pipe(
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
              Effect.timeout("20 seconds"),
              Effect.tapError(() => saveLogs),
            );
            yield* checkpoint("Tool-call trace delivered");
          }),
        );
        yield* checkpoint("Desktop closed");
        if (first) {
          // Quitting leaves the background server running for the CLI and MCP clients. Stopping
          // it with the CLI the desktop staged makes the next launch start one on the same data.
          const status = yield* cli.run(["service", "status"]);
          expect(status.code, status.stderr).toBe(0);
          expect(status.stdout).toContain(`${origin} (version `);
          const stopped = yield* cli.run(["service", "stop"]);
          expect(stopped.code, stopped.stderr).toBe(0);
          expect((yield* cli.run(["service", "status"])).stdout.trim()).toBe("stopped");
          yield* checkpoint("Background server stopped");
          // The server wrote its compiled code to the user's cache directory once the runtime
          // loaded, before any orderly exit.
          const entries = (yield* fs.exists(cache))
            ? yield* fs.readDirectory(cache, { recursive: true })
            : [];
          const files = yield* Effect.filter(entries, (entry) =>
            fs.stat(path.join(cache, entry)).pipe(Effect.map(({ type }) => type === "File")),
          );
          expect(files.length, "compiled code is cached after the first launch").toBeGreaterThan(0);
          if (process.platform !== "win32")
            expect((yield* fs.stat(cache)).mode & 0o777, "only this user can use the cache").toBe(
              0o700,
            );
          expect(
            yield* fs.exists(path.join(directory, "data", "compile-cache")),
            "the cache stays out of the data directory",
          ).toBe(false);
        }
      }
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);

it.live(
  "packaged desktop uses the background service's saved port and exports redacted diagnostics",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const executablePath = yield* Config.String("EXECUTOR_E2E_DESKTOP_EXECUTABLE");
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "executor-desktop-settings-",
        });
        const apiKey = randomBytes(32).toString("hex");
        const encryptionKey = randomBytes(32).toString("hex");
        const runtimePath = yield* Config.String("EXECUTOR_E2E_RUNTIME_PATH").pipe(
          Config.withDefault(process.env.PATH ?? ""),
        );
        const registry = yield* localNpmRegistry;
        const port = yield* freePort;
        const origin = `http://127.0.0.1:${port}`;
        const data = path.join(directory, "data");
        const downloads = path.join(directory, "downloads");
        // The OS per-user cache directory, which holds the backend's compile cache and the
        // updater's downloads, is this scenario's own, as in the scenario above.
        const cacheHome = path.join(directory, "cache-home");
        yield* fs.makeDirectory(data, { recursive: true });
        yield* fs.makeDirectory(downloads);
        // No EXECUTOR_PORT: the background service's saved setting chooses the listener.
        yield* fs.writeFileString(path.join(data, "service.json"), JSON.stringify({ port }));
        const env = {
          ...runnerSession(),
          PATH: runtimePath,
          HOME: process.platform === "darwin" ? cacheHome : (process.env.HOME ?? ""),
          ...(process.platform === "win32"
            ? { LOCALAPPDATA: cacheHome }
            : process.platform === "darwin"
              ? {}
              : { XDG_CACHE_HOME: cacheHome }),
          // Release scenarios never send product analytics, even from a build with a baked key.
          DO_NOT_TRACK: "1",
          EXECUTOR_API_KEY: apiKey,
          EXECUTOR_ENCRYPTION_KEY: encryptionKey,
          EXECUTOR_DESKTOP_DATA_DIR: data,
          EXECUTOR_DESKTOP_PROFILE_DIR: path.join(directory, "profile"),
          EXECUTOR_NPM_REGISTRY: registry.url,
        };
        yield* Effect.addFinalizer(() => stopBackgroundServers(data, () => []));
        const { electron } = yield* Effect.acquireRelease(
          driver("launch packaged desktop", () =>
            _electron.launch({ executablePath, cwd: directory, env, args: ["--disable-gpu"] }),
          ).pipe(Effect.map((electron) => ({ electron, output: captureOutput(electron) }))),
          ({ electron, output }) => closeDesktop(electron, { data, output }).pipe(Effect.orDie),
        );
        const page = yield* driver("desktop window", () => electron.firstWindow());
        yield* driver("paired dashboard", () =>
          page
            .getByRole("heading", { name: /^Apps/ })
            .waitFor({ state: "visible", timeout: 60_000 }),
        );
        expect(new URL(page.url()).origin).toBe(origin);

        const click = (menu: string, label: string) =>
          driver(`choose ${menu} → ${label}`, () =>
            electron.evaluate(
              ({ Menu }, [menu, label]) => {
                const item = Menu.getApplicationMenu()
                  ?.items.find((entry) => entry.label === menu)
                  ?.submenu?.items.find((entry) => entry.label === label);
                if (item === undefined) return false;
                item.click();
                return true;
              },
              [menu, label] as const,
            ),
          ).pipe(Effect.map((found) => expect(found).toBe(true)));

        // The port form shows the saved port and refuses one another program holds.
        const opened = electron.waitForEvent("window");
        yield* click("File", "Server port…");
        const form = yield* driver("port form", () => opened);
        yield* driver("port form heading", () =>
          form.getByRole("heading", { name: "Local server port" }).waitFor(),
        );
        expect(yield* driver("current port", () => form.getByLabel("Port").inputValue())).toBe(
          String(port),
        );
        expect(
          yield* driver("MCP address note", () =>
            form.getByText(`http://127.0.0.1:${port}`).count(),
          ),
        ).toBe(1);
        const busyPort = yield* freePort;
        const busy = yield* Effect.acquireRelease(
          driver("hold another port", () => {
            const server = createServer();
            return new Promise<typeof server>((resolve) =>
              server.listen(busyPort, "127.0.0.1", () => resolve(server)),
            );
          }),
          (server) => Effect.sync(() => server.close()),
        );
        expect(busy.listening).toBe(true);
        yield* driver("enter a busy port", () => form.getByLabel("Port").fill(String(busyPort)));
        yield* driver("submit with Enter", () => form.getByLabel("Port").press("Enter"));
        const alert = yield* driver("busy port refusal", () =>
          form.getByRole("alert").textContent(),
        );
        expect(alert).toBe(`Port ${busyPort} is in use by another program. Choose another port.`);
        expect(
          yield* fs
            .readFileString(path.join(data, "service.json"))
            .pipe(Effect.map((text) => JSON.parse(text))),
        ).toEqual({ port });
        yield* driver("cancel closes the port form", () =>
          Promise.all([
            form.waitForEvent("close"),
            form.getByRole("button", { name: "Cancel" }).click(),
          ]),
        );

        // Diagnostics export writes one zip with logs and a manifest, and no key or token values.
        yield* driver("redirect downloads", () =>
          electron.evaluate(({ app }, downloads) => app.setPath("downloads", downloads), downloads),
        );
        yield* click("Help", "Export diagnostics…");
        const zip = yield* fs.readDirectory(downloads).pipe(
          Effect.flatMap((names) => {
            const name = names.find((entry) =>
              /^executor-diagnostics-\d{8}T\d{6}Z\.zip$/.test(entry),
            );
            return name === undefined
              ? Effect.fail(new Error("No diagnostics zip yet"))
              : Effect.succeed(name);
          }),
          Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
        );
        const entries = unzipSync(yield* fs.readFile(path.join(downloads, zip)));
        const names = Object.keys(entries).sort();
        expect(names).toContain("manifest.json");
        expect(names).toContain("diagnostics/executor-desktop.jsonl");
        expect(names).toContain("diagnostics/executor-local.jsonl");
        expect(
          names.every((name) => name === "manifest.json" || name.startsWith("diagnostics/")),
        ).toBe(true);
        const manifest = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              server: Schema.Struct({ origin: Schema.String, portSource: Schema.String }),
              files: Schema.Array(Schema.String),
            }),
          ),
        )(strFromU8(yield* Effect.fromNullishOr(entries["manifest.json"])));
        expect(manifest.server).toEqual({ origin, portSource: "setting" });
        expect([...manifest.files].sort()).toEqual(
          names.filter((name) => name !== "manifest.json"),
        );
        for (const [name, bytes] of Object.entries(entries)) {
          const text = strFromU8(bytes);
          expect(text, name).not.toContain(apiKey);
          expect(text, name).not.toContain(encryptionKey);
          expect(text, name).not.toMatch(/#pair=[0-9a-f]/);
        }
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);

/**
 * A packaged desktop's own home for the quit scenarios: its data, profile and cache directories,
 * synthetic keys, a free port and the local registry. Its background server stops with the scope.
 */
const quitScenarioHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const executablePath = yield* Config.String("EXECUTOR_E2E_DESKTOP_EXECUTABLE");
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-desktop-quit-" });
  const registry = yield* localNpmRegistry;
  const cacheHome = path.join(directory, "cache-home");
  const data = path.join(directory, "data");
  const env = {
    ...runnerSession(),
    PATH: yield* Config.String("EXECUTOR_E2E_RUNTIME_PATH").pipe(
      Config.withDefault(process.env.PATH ?? ""),
    ),
    HOME: process.platform === "darwin" ? cacheHome : (process.env.HOME ?? ""),
    ...(process.platform === "win32"
      ? { LOCALAPPDATA: cacheHome }
      : process.platform === "darwin"
        ? {}
        : { XDG_CACHE_HOME: cacheHome }),
    DO_NOT_TRACK: "1",
    EXECUTOR_API_KEY: randomBytes(32).toString("hex"),
    EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    EXECUTOR_PORT: String(yield* freePort),
    EXECUTOR_DESKTOP_DATA_DIR: data,
    EXECUTOR_DESKTOP_PROFILE_DIR: path.join(directory, "profile"),
    EXECUTOR_NPM_REGISTRY: registry.url,
  };
  yield* Effect.addFinalizer(() => stopBackgroundServers(data, () => []));
  return { executablePath, directory, data, env };
});

it.live(
  "packaged desktop that does not exit after quitting fails its close within the bound, naming what kept it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { executablePath, directory, data, env } = yield* quitScenarioHome;
        const electron = yield* driver("launch packaged desktop", () =>
          _electron.launch({ executablePath, cwd: directory, env, args: ["--disable-gpu"] }),
        );
        const output = captureOutput(electron);
        const pid = yield* Effect.fromNullishOr(electron.process().pid);
        const page = yield* driver("desktop window", () => electron.firstWindow());
        yield* driver("paired dashboard", () =>
          page
            .getByRole("heading", { name: /^Apps/ })
            .waitFor({ state: "visible", timeout: 60_000 }),
        );
        // Something in the main process throws while the desktop quits. Electron then shows its
        // error box, which blocks the main process, so the desktop never exits.
        yield* driver("throw while the desktop quits", () =>
          electron.evaluate(({ app }) => {
            app.once("before-quit", () => {
              setTimeout(() => {
                throw new Error("Synthetic failure while quitting");
              }, 0);
            });
          }),
        );
        const started = yield* Clock.currentTimeMillis;
        const error = yield* Effect.flip(closeDesktop(electron, { data, output }));
        const seconds = ((yield* Clock.currentTimeMillis) - started) / 1_000;
        // The bound, then the evidence, whose every step is capped (see `closeLimit`).
        expect(seconds).toBeGreaterThanOrEqual(Duration.toSeconds(quitBound));
        expect(seconds).toBeLessThanOrEqual(Duration.toSeconds(closeLimit));
        expect(error.message).toContain(
          `did not exit within ${Duration.toSeconds(quitBound)} seconds of being asked to quit`,
        );
        expect(error.message).toContain("Main process: still running");
        expect(error.message).toContain("The desktop's quit records: quitting (before-quit)");
        expect(error.message).toContain("uncaught exception while closing");
        expect(error.message).toContain("Error: Synthetic failure while quitting");
        const evidence = /Evidence: (.+)$/u.exec(error.message)?.[1] ?? "";
        const quit = yield* fs
          .readFileString(path.join(evidence, "quit.json"))
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(
                  Schema.Struct({ pid: Schema.Number, mainProcessAlive: Schema.Boolean }),
                ),
              ),
            ),
          );
        expect(quit).toEqual({ pid, mainProcessAlive: true });
        expect(yield* fs.readFileString(path.join(evidence, "executor-desktop.jsonl"))).toContain(
          "Synthetic failure while quitting",
        );
        // The release workflow's evidence step files the folder under this scenario, so a failed
        // run's scenario evidence holds it, not only the job's diagnostics archive.
        const { currentTestName, testPath } = expect.getState();
        const report = path.join(directory, "results.json");
        yield* fs.writeFileString(
          report,
          JSON.stringify({
            testResults: [
              {
                name: testPath ?? "",
                assertionResults: [
                  {
                    title: currentTestName ?? "",
                    status: "failed",
                    failureMessages: [error.message],
                  },
                ],
              },
            ],
          }),
        );
        // Only this close's folder, so an earlier run's folders cannot stand in for it.
        const failures = path.join(directory, "failures");
        yield* fs.makeDirectory(failures);
        yield* fs.copy(evidence, path.join(failures, path.basename(evidence)));
        const filed = path.join(directory, "filed");
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const gathered = yield* processes.exitCode(
          ChildProcess.make(
            process.execPath,
            ["e2e/release-evidence.ts", "vitest", filed, "local", failures, report],
            { stdout: "ignore", stderr: "inherit" },
          ),
        );
        expect(gathered, "release-evidence.ts exit code").toBe(0);
        const scenarios = path.join(filed, "release", "local", "report", "evidence");
        const [id = ""] = yield* fs.readDirectory(scenarios);
        const kept = yield* fs
          .readFileString(path.join(scenarios, id, "desktop-1", "quit.json"))
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.Struct({ pid: Schema.Number })),
              ),
            ),
            Effect.option,
          );
        expect(
          Option.getOrUndefined(kept),
          "the hung close's folder is filed under this scenario's evidence",
        ).toEqual({ pid });
        // The failed close ended the desktop, so its scenario's clean-up runs.
        expect(
          yield* Effect.try(() => process.kill(pid, 0)).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        ).toBe(false);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);

// Not on Windows: the scenario's mechanism, a signal sent to the desktop, a shell that wires its
// stderr to a pipe and a reader the scenario kills, is POSIX. The quit-record code it proves is the
// same on every platform.
it.live.skipIf(process.platform === "win32")(
  "packaged desktop whose stderr reader has gone quits on SIGINT and records its quit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { executablePath, directory, data, env } = yield* quitScenarioHome;
        const readerFile = path.join(directory, "stderr-reader.pid");
        // Started directly, not through Playwright, which reads the desktop's output to the end.
        // Its stderr is a pipe into a reader this scenario ends, as Ctrl-C ends the command a
        // terminal pipes the desktop's output into, `executor-v2 2>&1 | grep …`, as it quits it.
        const desktop = yield* processes.spawn(
          ChildProcess.make(
            "/bin/bash",
            [
              "-c",
              // The reader writes its own process ID with POSIX `$$`: macOS's Bash 3.2 has no
              // $BASHPID. It then becomes `cat`, which keeps that ID.
              `reader=$1; shift; exec 2> >(exec /bin/sh -c 'echo $$ > "$1"; exec /bin/cat > /dev/null' reader "$reader"); exec "$@"`,
              "desktop",
              readerFile,
              executablePath,
              "--no-sandbox",
              "--disable-gpu",
            ],
            {
              cwd: directory,
              env,
              extendEnv: false,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "inherit",
              detached: true,
              forceKillAfter: 1_000,
            },
          ),
        );
        yield* eventsNamed(data, "Executor desktop ready", 1);
        const reader = Number((yield* fs.readFileString(readerFile)).trim());
        expect(reader).toBeGreaterThan(0);
        yield* Effect.try(() => process.kill(reader, "SIGKILL"));
        // The reader has exited, and so closed its end, once it is a zombie or gone: the shell
        // that started it became the desktop, which never reaps it.
        yield* processes
          .lines(ChildProcess.make("/bin/ps", ["-o", "stat=", "-p", String(reader)]))
          .pipe(
            Effect.orElseSucceed(() => []),
            Effect.flatMap((lines) => {
              const state = (lines[0] ?? "").trim();
              return state === "" || state.startsWith("Z")
                ? Effect.void
                : Effect.fail(new Error(`The stderr reader is still running (${state})`));
            }),
            Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }),
          );
        // At once, so nothing but the quit writes to the pipe whose reader has gone.
        yield* Effect.try(() => process.kill(desktop.pid, "SIGINT"));
        const exit = yield* desktop.exitCode.pipe(Effect.timeoutOption(quitBound));
        expect(
          Option.getOrUndefined(exit),
          "the desktop's exit code, within the bound, after SIGINT",
        ).toBe(0);
        const events = yield* desktopEvents(data);
        // Electron turns SIGINT into its own quit, so the desktop records it as `before-quit`.
        expect(
          events
            .filter((event) =>
              ["Desktop quitting", "Desktop closed", "Desktop uncaught exception"].includes(
                event.message,
              ),
            )
            .map(({ message, annotations }) => ({
              message,
              reason: annotations.reason,
              outcome: annotations.outcome,
            })),
        ).toEqual([
          { message: "Desktop quitting", reason: "before-quit", outcome: undefined },
          { message: "Desktop closed", reason: undefined, outcome: "success" },
        ]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);

it.live(
  "packaged desktop records any thrown value as an uncaught exception and keeps running",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executablePath, directory, data, env } = yield* quitScenarioHome;
        const { electron } = yield* Effect.acquireRelease(
          driver("launch packaged desktop", () =>
            _electron.launch({ executablePath, cwd: directory, env, args: ["--disable-gpu"] }),
          ).pipe(Effect.map((electron) => ({ electron, output: captureOutput(electron) }))),
          ({ electron, output }) => closeDesktop(electron, { data, output }).pipe(Effect.orDie),
        );
        yield* eventsNamed(data, "Starting Executor desktop", 1);
        // Electron's own box for an uncaught exception would block the main process; it is
        // replaced by a recorder, so each throw is seen by the desktop and Electron alike.
        // Values that are not Errors: null, undefined, an object with no prototype and a string.
        yield* driver("throw values that are not Errors from the main process", () =>
          electron.evaluate(({ dialog }) => {
            const shown: Array<string> = [];
            Object.assign(globalThis, { executorE2EErrorBoxes: shown });
            Object.assign(dialog, { showErrorBox: (title: string) => shown.push(title) });
            const values: ReadonlyArray<() => unknown> = [
              () => null,
              () => undefined,
              () => Object.create(null),
              () => "Synthetic thrown text",
              () => new Error("Synthetic thrown error"),
            ];
            values.forEach((value, index) =>
              setTimeout(() => {
                throw value();
              }, index * 50),
            );
          }),
        );
        const recorded = yield* eventsNamed(data, "Desktop uncaught exception", 5);
        const described = recorded.map((event) => event.annotations.error?.split("\n")[0]);
        expect(described).toEqual(
          expect.arrayContaining([
            "null",
            "undefined",
            "[object Object]",
            "Synthetic thrown text",
            "Error: Synthetic thrown error",
          ]),
        );
        // The desktop still runs and answers.
        expect(yield* driver("the desktop still answers", () => electron.evaluate(() => 1))).toBe(
          1,
        );
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);
