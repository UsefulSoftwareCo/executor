import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, FileSystem, Path, Redacted, Schedule, Schema } from "effect";
import { _electron, chromium } from "playwright";
import { randomBytes, randomUUID } from "node:crypto";
import { driver } from "../support/platform.ts";
import { freePort } from "../support/ports.ts";
import { requestBrowserPairing } from "../support/desktop.ts";
import { authorizeBrowserMcp } from "../support/mcp-oauth.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Collector, SpanQuery } from "../support/contracts.ts";

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
      const origin = `http://127.0.0.1:${port}`;
      const mcpUrl = new URL(`${origin}/mcp`);
      const env = {
        ...Object.fromEntries(
          [
            "DISPLAY",
            "XAUTHORITY",
            "WAYLAND_DISPLAY",
            "XDG_RUNTIME_DIR",
            "XDG_SESSION_TYPE",
            "DBUS_SESSION_BUS_ADDRESS",
          ].flatMap((name) => {
            const value = process.env[name];
            return value === undefined ? [] : [[name, value] as const];
          }),
        ),
        PATH: runtimePath,
        HOME: process.env.HOME ?? "",
        EXECUTOR_API_KEY: apiKey,
        EXECUTOR_ENCRYPTION_KEY: encryptionKey,
        EXECUTOR_PORT: String(port),
        EXECUTOR_DESKTOP_DATA_DIR: path.join(directory, "data"),
        EXECUTOR_DESKTOP_PROFILE_DIR: path.join(directory, "profile"),
      };
      let appId = "";
      let appSlug = "";
      let profileId = "";
      let appUiUrl: string | undefined;
      let oauthToken: Redacted.Redacted<string> | undefined;
      const diagnostics: string[] = [];
      const checkpoint = (stage: string) =>
        Effect.sync(() => {
          diagnostics.push(
            `${JSON.stringify({ checkpoint: stage, at: new Date().toISOString() })}\n`,
          );
        });
      yield* Effect.addFinalizer(() =>
        fs
          .writeFileString(".local/releases/desktop-test.log", diagnostics.join(""), {
            mode: 0o600,
          })
          .pipe(Effect.orDie),
      );
      const browser = yield* Effect.acquireRelease(
        driver("launch an independent browser", () => chromium.launch()),
        (browser) => driver("close independent browser", () => browser.close()).pipe(Effect.orDie),
      );
      for (const first of [true, false]) {
        yield* checkpoint(first ? "Verify first desktop launch" : "Verify desktop restart");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const electron = yield* Effect.acquireRelease(
              driver("launch packaged desktop", () =>
                // Hosted runners have no usable GPU. Exercise the packaged app
                // with software rendering instead of repeated GPU startup failures.
                _electron.launch({ executablePath, cwd: directory, env, args: ["--disable-gpu"] }),
              ),
              (electron) =>
                driver("close packaged desktop", () => electron.close()).pipe(Effect.orDie),
            );
            const capture = (chunk: Uint8Array) =>
              diagnostics.push(new TextDecoder().decode(chunk));
            electron.process().stderr?.on("data", capture);
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
            );
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
                        content: `import { defineApp, defineProvider, secrets, query, object, string } from "apps";
import isNumber from "is-number";
const service = defineProvider({ name: "Desktop test service", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) }),
} });
export const check = (token: string) => query({ input: object({}) }, async () => ({
  numeric: isNumber("2"), connected: token === "synthetic-desktop-token",
}));
export default defineApp({ accounts: { service } }, async ({ accounts }) => ({
  queries: { check: check(accounts.service.fields.token) },
}));`,
                      },
                      {
                        path: "package.json",
                        content: JSON.stringify({
                          dependencies: {
                            "is-number": "7.0.0",
                            react: "19.2.0",
                            "react-dom": "19.2.0",
                          },
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
              const deployed = yield* driver("deployment response", () => response.json());
              const created = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ app: Schema.Struct({ id: Schema.String, slug: Schema.String }) }),
              )(deployed);
              appId = created.app.id;
              appSlug = created.app.slug;
              const profileResponse = yield* driver("create the local app profile", () =>
                page.request.post(`${origin}/v1/apps/${appId}/profiles`, {
                  headers: { authorization: `Bearer ${apiKey}` },
                  data: {
                    owner: "local",
                    subject: "local",
                    accounts: {},
                    idempotencyKey: randomUUID(),
                  },
                }),
              );
              expect(profileResponse.status()).toBe(200);
              const profile = yield* driver("read the local app profile", () =>
                profileResponse.json(),
              ).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))),
              );
              profileId = profile.id;
              const connectionResponse = yield* driver(
                "request a targeted account connection",
                () =>
                  page.request.post(`${origin}/account-connect/api/requests`, {
                    headers: { authorization: `Bearer ${apiKey}` },
                    data: {
                      owner: "local",
                      target: { app: appId, profile: profileId, requirement: "service" },
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
                    code: `return await tools[${JSON.stringify(appSlug)}].profiles[${JSON.stringify(profileId)}].queries.check({})`,
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
                data: { app: appId, profile: profileId, tool: "queries.check", input: {} },
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
                return yield* Effect.fail(new Error("The actual tool-call trace must reach Motel"));
            }).pipe(
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
              Effect.timeout("20 seconds"),
            );
            yield* checkpoint("Tool-call trace delivered");
          }),
        );
        yield* checkpoint("Desktop closed");
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
