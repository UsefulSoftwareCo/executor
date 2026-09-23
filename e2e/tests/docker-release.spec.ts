import { randomUUID } from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, Exit, Redacted, Schema, Schedule } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { driver } from "../support/platform.ts";
import { authorizeBrowserMcp } from "../support/mcp-oauth.ts";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

for (const mode of ["explicit", "local", "railway"] as const)
  it.live(`released image keeps login and encrypted credentials across restart (${mode})`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const image = yield* Config.String("EXECUTOR_E2E_DOCKER_IMAGE");
        const architecture = yield* Config.String("EXECUTOR_E2E_DOCKER_ARCH");
        const version = yield* Config.NonEmptyString("EXECUTOR_E2E_DOCKER_VERSION");
        const id = `executor-release-${randomBytes(8).toString("hex")}`;
        const run = (args: readonly string[], env: Record<string, string> = {}) =>
          processes.string(
            ChildProcess.make("docker", args, { env, extendEnv: true, stderr: "inherit" }),
          );
        expect(
          (yield* run(["image", "inspect", "--format", "{{.Architecture}}", image])).trim(),
        ).toBe(architecture);
        const port = yield* Effect.scoped(
          Effect.gen(function* () {
            const listener = yield* Effect.acquireRelease(
              Effect.sync(() => createServer()),
              (listener) =>
                driver(
                  "release port",
                  () => new Promise<void>((resolve) => listener.close(() => resolve())),
                ).pipe(Effect.orDie),
            );
            return yield* driver(
              "allocate port",
              () =>
                new Promise<number>((resolve, reject) => {
                  listener.once("error", reject);
                  listener.listen(0, "127.0.0.1", () => {
                    const address = listener.address();
                    if (address === null || typeof address === "string")
                      reject(new Error("No test port"));
                    else resolve(address.port);
                  });
                }),
            );
          }),
        );
        const address = `http://127.0.0.1:${port}`;
        // Keep the container listener outside the OS ephemeral port range used
        // by the embedded app runtime. Only the published host port is random.
        const containerPort = 8080;
        const origin =
          mode === "railway"
            ? "https://release.up.railway.app"
            : `http://localhost:${mode === "local" ? containerPort : port}`;
        const secret = randomBytes(32).toString("hex");
        const key = randomBytes(32).toString("hex");
        yield* Effect.acquireRelease(run(["volume", "create", id]), () =>
          run(["volume", "rm", id]).pipe(Effect.orDie),
        );
        // Railway volumes do not inherit the image directory's owner.
        if (mode === "railway")
          yield* run([
            "run",
            "--rm",
            "--user",
            "0",
            "--entrypoint",
            "sh",
            "--volume",
            `${id}:/app/data`,
            image,
            "-c",
            "chown 0:0 /app/data && chmod 755 /app/data",
          ]);
        const environment: Record<string, string> = {
          PORT: String(containerPort),
          ...(mode === "explicit"
            ? {
                BETTER_AUTH_SECRET: secret,
                EXECUTOR_ENCRYPTION_KEY: key,
                BETTER_AUTH_URL: origin,
                RAILWAY_PUBLIC_DOMAIN: "ignored.invalid/path",
              }
            : {}),
          ...(mode === "railway" ? { RAILWAY_PUBLIC_DOMAIN: "release.up.railway.app" } : {}),
        };
        const start = () =>
          run(
            [
              "run",
              "--detach",
              "--name",
              id,
              "--init",
              "--publish",
              `127.0.0.1:${port}:${containerPort}`,
              "--volume",
              `${id}:/app/data`,
              ...Object.keys(environment).flatMap((name) => ["--env", name]),
              image,
            ],
            environment,
          );
        yield* Effect.acquireRelease(start(), () => run(["rm", "--force", id]).pipe(Effect.orDie));
        const request = (route: string, data?: unknown, cookie?: string, trace?: string) =>
          driver("image HTTP request", () =>
            fetch(`${address}${route}`, {
              method: data === undefined ? "GET" : "POST",
              headers: {
                origin,
                "content-type": "application/json",
                ...(cookie === undefined ? {} : { cookie }),
                ...(trace === undefined ? {} : { traceparent: `00-${trace}-1234567890abcdef-01` }),
              },
              ...(data === undefined ? {} : { body: JSON.stringify(data) }),
            }),
          );
        yield* Effect.addFinalizer((exit) =>
          Exit.isFailure(exit)
            ? run(["logs", id]).pipe(Effect.flatMap(Console.error), Effect.ignore)
            : Effect.void,
        );
        const ready = request("/health").pipe(
          Effect.flatMap((r) => (r.status === 200 ? Effect.void : Effect.fail("not ready"))),
          Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 200 }),
        );
        yield* ready;
        const serverPid = (yield* run(["exec", id, "cat", "/proc/1/task/1/children"])).trim();
        expect(serverPid).toMatch(/^\d+$/);
        const serverStatus = yield* run(["exec", id, "cat", `/proc/${serverPid}/status`]);
        expect(serverStatus).toMatch(/^Uid:\s+1000\s+1000\s+1000\s+1000$/m);
        const discovery = yield* request("/.well-known/oauth-authorization-server");
        const metadata = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ issuer: Schema.String }),
        )(yield* driver("OAuth origin", () => discovery.json()));
        expect(metadata.issuer).toBe(`${origin}/api/auth`);
        if (mode !== "explicit") {
          expect(
            (yield* run([
              "exec",
              id,
              "stat",
              "-c",
              "%a",
              "/app/data/auth-secret.key",
              "/app/data/encryption.key",
            ])).trim(),
          ).toBe("600\n600");
        }
        const root = yield* request("/");
        expect(root.status).toBe(200);
        expect(yield* driver("dashboard HTML", () => root.text())).toContain("<html");
        const setup = yield* request("/api/auth/self-host/setup", {
          name: "Release Owner",
          email: "release@example.test",
          password: "Synthetic-release-password-123!",
          organizationName: "Release lab",
        });
        expect(setup.status).toBe(200);
        const cookie = setup.headers
          .getSetCookie()
          .map((part) => part.split(";")[0])
          .join("; ");
        const organizations = yield* request("/api/auth/organization/list", undefined, cookie);
        expect(organizations.status).toBe(200);
        const parsed = yield* Schema.decodeUnknownEffect(
          Schema.NonEmptyArray(Schema.Struct({ id: Schema.String, slug: Schema.String })),
        )(yield* driver("organization response", () => organizations.json()));
        const prefix = `/api/organizations/${parsed[0].id}`;
        const deployed = yield* request(
          `${prefix}/apps/deploy`,
          {
            name: "Image check",
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, secrets, string, query, object } from "apps"; import isNumber from "is-number"; const service = defineProvider({ name: "Release test", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } }); export default defineApp({ accounts: { service } }, async ({ accounts }) => ({ queries: { check: query({ input: object({}) }, async () => isNumber("2") && accounts.service.fields.token === "synthetic-release-token") } }));`,
              },
              {
                path: "package.json",
                content: JSON.stringify({ dependencies: { "is-number": "7.0.0" } }),
              },
            ],
          },
          cookie,
        );
        expect(
          deployed.status,
          yield* driver("deployment result", () => deployed.clone().text()),
        ).toBe(200);
        const app = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ id: Schema.String, slug: Schema.String }),
        )(yield* driver("deployment response", () => deployed.json()));
        const profileResponse = yield* request(
          `${prefix}/apps/${app.id}/profiles`,
          { accounts: {}, idempotencyKey: randomUUID() },
          cookie,
        );
        expect(profileResponse.status).toBe(200);
        const profile = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
          yield* driver("profile response", () => profileResponse.json()),
        );
        const connectionResponse = yield* request(
          `${prefix}/apps/${app.id}/connections`,
          { requirement: "service", profile: profile.id },
          cookie,
        );
        expect(connectionResponse.status).toBe(200);
        const connection = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
          yield* driver("connection response", () => connectionResponse.json()),
        );
        const connected = yield* request(
          `${prefix}/connections/${connection.id}/submit`,
          { method: "key", label: "Release account", fields: { token: "synthetic-release-token" } },
          cookie,
        );
        expect(connected.status).toBe(200);
        const token =
          mode === "explicit"
            ? yield* Effect.gen(function* () {
                const browser = yield* Effect.acquireRelease(
                  driver("launch the image login browser", () => chromium.launch()),
                  (browser) =>
                    driver("close the image browser", () => browser.close()).pipe(Effect.orDie),
                );
                const page = yield* driver("new browser session", () => browser.newPage());
                yield* driver("open image sign-in", () => page.goto(`${origin}/login`));
                yield* driver("enter the setup user's email", () =>
                  page.getByLabel("Email", { exact: true }).fill("release@example.test"),
                );
                yield* driver("enter the setup user's password", () =>
                  page
                    .getByLabel("Password", { exact: true })
                    .fill("Synthetic-release-password-123!"),
                );
                yield* driver("sign in through the image dashboard", () =>
                  page.getByRole("button", { name: "Sign in", exact: true }).click(),
                );
                yield* driver("sign-in reaches the intended organization", () =>
                  page.waitForURL(
                    (url) =>
                      url.origin === origin && url.pathname === `/org/${parsed[0].slug}/apps`,
                  ),
                );
                yield* driver("the image dashboard is authenticated", () =>
                  page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
                );
                return yield* authorizeBrowserMcp(page, origin);
              })
            : undefined;
        for (const restart of [false, true]) {
          if (restart) {
            yield* run(["stop", "--time", "15", id]);
            yield* run(["rm", id]);
            yield* start();
            yield* ready;
          }
          const trace = randomBytes(16).toString("hex");
          const viewer = yield* request("/api/viewer", undefined, cookie, trace);
          expect(viewer.status).toBe(200);
          const delivered = yield* run([
            "exec",
            id,
            "node",
            "-e",
            `
const fs = require("node:fs");
const collector = JSON.parse(fs.readFileSync("/app/data/diagnostics/collector.json", "utf8"));
fetch(collector.url + "/api/traces/" + process.argv[1] + "/spans").then((r) => r.text()).then((text) => process.stdout.write(text));
`,
            trace,
          ]).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(
                  Schema.Struct({
                    data: Schema.Array(
                      Schema.Struct({
                        span: Schema.Struct({
                          serviceName: Schema.String,
                          tags: Schema.Record(Schema.String, Schema.String),
                        }),
                      }),
                    ),
                  }),
                ),
              ),
            ),
            Effect.flatMap((trace) =>
              trace.data.some(
                ({ span }) =>
                  span.serviceName === "executor-selfhost" &&
                  span.tags["service.version"] === version,
              )
                ? Effect.succeed(trace)
                : Effect.fail("Released version has not reached the collector"),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 30 }),
          );
          expect(delivered.data.some(({ span }) => span.tags["service.version"] === version)).toBe(
            true,
          );
          const called = yield* request(
            `${prefix}/apps/${app.id}/tools/call`,
            { profile: profile.id, tool: "queries.check", input: {} },
            cookie,
          );
          expect(called.status).toBe(200);
          expect(yield* driver("query response", () => called.json())).toBe(true);
          if (token !== undefined) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const client = yield* Effect.acquireRelease(
                  Effect.sync(() => new Client({ name: "image-release", version: "1" })),
                  (client) =>
                    driver("close image MCP client", () => client.close()).pipe(Effect.orDie),
                );
                const transport: Omit<StreamableHTTPClientTransport, "sessionId"> =
                  new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
                    requestInit: { headers: { authorization: `Bearer ${Redacted.value(token)}` } },
                  });
                yield* driver("connect to image with the saved OAuth token", () =>
                  client.connect(transport),
                );
                const result = yield* driver(
                  "call the account-backed app through image MCP",
                  (signal) =>
                    client.callTool(
                      {
                        name: "execute",
                        arguments: {
                          code: `return await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(profile.id)}].queries.check({})`,
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
                )(result.structuredContent);
                expect(completed.execution.value).toBe(true);
              }),
            );
          }
        }
        if (mode !== "explicit") {
          yield* run(["stop", "--time", "15", id]);
          yield* run(["rm", id]);
          // Losing one key must not silently generate a replacement for existing data.
          yield* run([
            "run",
            "--rm",
            "--volume",
            `${id}:/app/data`,
            image,
            ...(mode === "local"
              ? ["rm", "/app/data/encryption.key"]
              : ["sh", "-c", "printf broken-key > /app/data/encryption.key"]),
          ]);
          yield* start();
          expect((yield* run(["wait", id])).trim()).not.toBe("0");
          const logs = yield* run(["logs", id]);
          expect(logs).toContain(
            mode === "local"
              ? "EXECUTOR_ENCRYPTION_KEY is missing for an existing database"
              : "Saved EXECUTOR_ENCRYPTION_KEY is invalid",
          );
          expect(logs).not.toContain("broken-key");
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
