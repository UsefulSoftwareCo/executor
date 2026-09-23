import { randomUUID } from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Config,
  Console,
  Effect,
  Exit,
  FileSystem,
  Path,
  Redacted,
  Schema,
  Schedule,
  Stream,
} from "effect";
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
        const initialImage = yield* Config.String("EXECUTOR_E2E_DOCKER_PREVIOUS_IMAGE").pipe(
          Config.withDefault(image),
        );
        const architecture = yield* Config.String("EXECUTOR_E2E_DOCKER_ARCH");
        const version = yield* Config.NonEmptyString("EXECUTOR_E2E_DOCKER_VERSION");
        const id = `executor-release-${randomBytes(8).toString("hex")}`;
        const run = (args: readonly string[], env: Record<string, string> = {}) =>
          processes.string(
            ChildProcess.make("docker", args, {
              env,
              extendEnv: true,
              stderr: args[0] === "logs" ? "pipe" : "inherit",
            }),
            { includeStderr: args[0] === "logs" },
          );
        const initialEnvironment = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Array(Schema.String)),
        )(yield* run(["image", "inspect", "--format", "{{json .Config.Env}}", initialImage]));
        const imageRuntime = (tag: string) =>
          run(["image", "inspect", "--format", "{{json .Config.Cmd}}", tag]).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.NonEmptyArray(Schema.String)),
              ),
            ),
            Effect.flatMap((command) =>
              Schema.decodeUnknownEffect(Schema.Literals(["node", "bun", "executor-host"]))(
                command[0],
              ),
            ),
          );
        const initialRuntime = yield* imageRuntime(initialImage);
        const runtime = yield* imageRuntime(image);
        const initialVersion = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
          initialEnvironment
            .find((value) => value.startsWith("EXECUTOR_BUILD_VERSION="))
            ?.slice("EXECUTOR_BUILD_VERSION=".length),
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
          EXECUTOR_APP_UI_BASE_URL: origin,
          ...(mode === "explicit"
            ? {
                BETTER_AUTH_SECRET: secret,
                EXECUTOR_ENCRYPTION_KEY: key,
                BETTER_AUTH_URL: origin,
                RAILWAY_PUBLIC_DOMAIN: "ignored.invalid/path",
                EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "false",
                EXECUTOR_URL_ALLOW_HTTP_ORIGINS: '["http://allowed.example.test:8091"]',
              }
            : {}),
          ...(mode === "railway" ? { RAILWAY_PUBLIC_DOMAIN: "release.up.railway.app" } : {}),
        };
        const start = (containerImage = image) =>
          run(
            [
              "run",
              "--detach",
              "--name",
              id,
              "--init",
              "--add-host",
              "allowed.example.test:127.0.0.1",
              "--add-host",
              "blocked.example.test:127.0.0.1",
              "--publish",
              `127.0.0.1:${port}:${containerPort}`,
              "--volume",
              `${id}:/app/data`,
              ...Object.keys(environment).flatMap((name) => ["--env", name]),
              containerImage,
            ],
            environment,
          );
        yield* Effect.acquireRelease(start(initialImage), () =>
          run(["rm", "--force", id]).pipe(Effect.orDie),
        );
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
                content: `import { defineApp, defineDatabase, table, defineProvider, secrets, string, query, mutation, workflow, object } from "apps";
import isNumber from "is-number";
const service = defineProvider({ name: "Release test", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
const database = defineDatabase({ messages: table({ body: string() }) });
export default defineApp({ accounts: { service }, database }, async ({ accounts }) => ({
  queries: {
    check: query({ input: object({}) }, async () => isNumber("2") && accounts.service.fields.token === "synthetic-release-token"),
    messages: query({ input: object({}) }, async ({ db }) => (await db.messages.withIndex("by_creation").collect()).map(row => row.body))
  },
  mutations: { save: mutation({ input: object({ body: string() }) }, async ({ db }, input) => { await db.messages.insert(input); return input.body; }) },
  workflows: { check: workflow({ input: object({}) }, async (ctx) =>
    ctx.step.do("credential", async (step) => step.accounts.service.fields.token === "synthetic-release-token")) }
}));`,
              },
              {
                path: "package.json",
                content: JSON.stringify({ dependencies: { "is-number": "7.0.0" } }),
              },
              {
                path: "ui/index.html",
                content:
                  '<!doctype html><html><head><title>Release app</title><link rel="stylesheet" href="./style.css"></head><body class="p-4"><h1>Release app</h1><script type="module" src="./main.ts"></script></body></html>',
              },
              { path: "ui/style.css", content: '@import "tailwindcss";' },
              {
                path: "ui/main.ts",
                content:
                  'import { createAppClient } from "apps/client"; const client = createAppClient(); document.querySelector("h1").textContent = client ? "Compiled release app" : "Missing client";',
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
                page.setDefaultTimeout(15_000);
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
        const saved = yield* request(
          `${prefix}/apps/${app.id}/tools/call`,
          { profile: profile.id, tool: "mutations.save", input: { body: "Retained app data" } },
          cookie,
        );
        expect(saved.status, yield* driver("save app data", () => saved.clone().text())).toBe(200);
        const legacyDigest = () =>
          run([
            "run",
            "--rm",
            "--volumes-from",
            id,
            "node:24-bookworm-slim",
            "node",
            "-e",
            `const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const hash=crypto.createHash("sha256");
function visit(directory){for(const name of fs.readdirSync(directory).sort()){const file=path.join(directory,name);hash.update(file);const stat=fs.lstatSync(file);if(stat.isDirectory())visit(file);else if(stat.isFile())hash.update(fs.readFileSync(file));else throw Error("Unexpected legacy file");}}
visit("/app/data/hosted.pglite");process.stdout.write(hash.digest("hex"));`,
          ]).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
            ),
          );
        let nativeBackup: string | undefined;
        let beforeRestartTrace: string | undefined;
        for (const restart of [false, true]) {
          if (restart) {
            yield* run(
              initialRuntime === "executor-host" && mode === "local"
                ? ["kill", "--signal", "KILL", id]
                : ["stop", "--time", "15", id],
            );
            if (initialRuntime !== "executor-host" && runtime === "executor-host")
              nativeBackup = yield* legacyDigest();
            yield* run(["rm", id]);
            if (nativeBackup !== undefined && mode === "local") {
              const control = "/app/data/hosted.pglite/global/pg_control";
              const held = "/app/data/pg_control.test-backup";
              const move = (from: string, to: string, truncate = false) =>
                run([
                  "run",
                  "--rm",
                  "--volume",
                  `${id}:/app/data`,
                  "node:24-bookworm-slim",
                  "node",
                  "-e",
                  "const fs=require('node:fs');fs.renameSync(process.argv[1], process.argv[2]);if(process.argv[3]==='true')fs.writeFileSync(process.argv[1],new Uint8Array(1));",
                  from,
                  to,
                  String(truncate),
                ]);
              // Complete the byte copy, then force PostgreSQL open to reject a truncated control file.
              // Retrying after repair must recopy that failed bootstrap, not reuse its imported bytes.
              yield* move(control, held, true);
              yield* start();
              const refused = yield* request("/health").pipe(
                Effect.flatMap((response) =>
                  response.status === 503 ? Effect.fail("starting") : Effect.succeed(response),
                ),
                Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
              );
              expect(
                refused.status,
                "an incomplete PostgreSQL import cannot open an empty product",
              ).toBe(500);
              yield* run(["stop", "--time", "15", id]);
              yield* run(["rm", id]);
              yield* move(held, control);
            }
            yield* start();
            yield* ready;
            if (nativeBackup !== undefined)
              expect(
                yield* legacyDigest(),
                "migration preserves the complete native database backup",
              ).toBe(nativeBackup);
          }
          if (mode === "explicit") {
            // Exercise the packaged Git HTTP backend, including its pack subprocesses.
            // Deployment alone only covers Git's built-in local repository commands.
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const directory = yield* fs.makeTempDirectoryScoped({ prefix: "release-git-" });
            const keyResponse = yield* request(
              "/api/auth/api-key/create",
              { name: "Release Git check" },
              cookie,
            );
            expect(
              keyResponse.status,
              keyResponse.status === 200
                ? "Git API key creation"
                : yield* driver("Git key error", () => keyResponse.text()),
            ).toBe(200);
            const gitKey = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
            )(yield* driver("Git key", () => keyResponse.json()));
            const gitResponse = yield* request(`${prefix}/apps/${app.id}/git`, undefined, cookie);
            expect(gitResponse.status).toBe(200);
            const remote = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ path: Schema.String }),
            )(yield* driver("Git address", () => gitResponse.json()));
            const git = (args: readonly string[]) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const child = yield* processes.spawn(
                    ChildProcess.make("git", args, {
                      cwd: directory,
                      extendEnv: true,
                      env: {
                        GIT_TERMINAL_PROMPT: "0",
                        GIT_CONFIG_NOSYSTEM: "1",
                        GIT_CONFIG_GLOBAL: "/dev/null",
                        GIT_CONFIG_COUNT: "1",
                        GIT_CONFIG_KEY_0: "http.extraHeader",
                        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${Redacted.value(gitKey.key)}`,
                        GIT_AUTHOR_NAME: "Release check",
                        GIT_AUTHOR_EMAIL: "release@example.test",
                        GIT_COMMITTER_NAME: "Release check",
                        GIT_COMMITTER_EMAIL: "release@example.test",
                      },
                      stderr: "inherit",
                      stdout: "pipe",
                    }),
                  );
                  const output = yield* child.stdout.pipe(Stream.decodeText, Stream.mkString);
                  expect(Number(yield* child.exitCode), `git ${args[0]}`).toBe(0);
                  return output;
                }),
              );
            yield* git(["clone", "--quiet", `${address}${remote.path}`, "."]);
            const marker = restart ? "after restart" : "before restart";
            yield* fs.writeFileString(path.join(directory, "release-check.txt"), marker);
            yield* git(["add", "release-check.txt"]);
            yield* git(["commit", "--quiet", "-m", "Verify source push"]);
            yield* git(["push", "--quiet", "origin", "HEAD:main"]);
            const commit = (yield* git(["rev-parse", "HEAD"])).trim();
            const workspaceResponse = yield* request(
              `${prefix}/apps/${app.id}/workspace`,
              undefined,
              cookie,
            );
            expect(workspaceResponse.status).toBe(200);
            const workspace = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                revision: Schema.Struct({ commit: Schema.String }),
                files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
              }),
            )(yield* driver("Pushed source", () => workspaceResponse.json()));
            expect(workspace.revision.commit).toBe(commit);
            expect(workspace.files).toContainEqual({ path: "release-check.txt", content: marker });
            expect(
              (yield* request("/api/auth/api-key/delete", { keyId: gitKey.id }, cookie)).status,
            ).toBe(200);
          }
          const trace = randomBytes(16).toString("hex");
          const expectedVersion = restart ? version : initialVersion;
          const viewer = yield* request("/api/viewer", undefined, cookie, trace);
          expect(viewer.status).toBe(200);
          if (mode === "explicit") {
            const fixture = `${id}-network-${Number(restart)}`;
            // Both listeners belong to the disposable container. A refused DNS
            // answer must never open the second listener, even during redirects.
            yield* Effect.acquireRelease(
              run([
                "run",
                "--detach",
                "--name",
                fixture,
                "--network",
                `container:${id}`,
                "node:24-bookworm-slim",
                "node",
                "-e",
                `
const http = require("node:http");
const net = require("node:net");
const hosts = [];
let blockedConnections = 0;
net.createServer(socket => { blockedConnections++; socket.destroy(); }).listen(8092, "::");
http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/stats") return response.end(JSON.stringify({ hosts, blockedConnections }));
  hosts.push(request.headers.host);
  if (request.url === "/redirect") {
    response.writeHead(302, { location: "https://blocked.example.test:8092/definition" }).end();
    return;
  }
  response.end(JSON.stringify({
    openapi: "3.0.3", info: { title: "Release network fixture", version: "1.0.0" },
    servers: [{ url: "https://api.example.test" }],
    paths: { "/ping": { get: { operationId: "ping", responses: { "200": { description: "OK" } } } } }
  }));
}).listen(8091, "::");
`,
              ]),
              () => run(["rm", "--force", fixture]).pipe(Effect.orDie),
            );
            const stats = run([
              "exec",
              fixture,
              "node",
              "-e",
              'fetch("http://127.0.0.1:8091/stats").then(r => r.text()).then(text => process.stdout.write(text))',
            ]).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.fromJsonString(
                    Schema.Struct({
                      hosts: Schema.Array(Schema.String),
                      blockedConnections: Schema.Number,
                    }),
                  ),
                ),
              ),
            );
            yield* stats.pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 30 }));
            const imported = yield* request(
              `${prefix}/apps/import`,
              {
                source: {
                  kind: "openapi",
                  name: `Allowed import ${Number(restart)}`,
                  url: "http://allowed.example.test:8091/definition",
                },
              },
              cookie,
            );
            expect(
              imported.status,
              yield* driver("allowed import", () => imported.clone().text()),
            ).toBe(200);
            for (const url of [
              "https://blocked.example.test:8092/definition",
              "http://allowed.example.test:8091/redirect",
            ]) {
              const refused = yield* request(
                `${prefix}/apps/import`,
                {
                  source: { kind: "openapi", name: "Blocked import", url },
                },
                cookie,
              );
              expect(yield* driver("refused import", () => refused.json())).toMatchObject({
                _tag: "CatalogImportFailed",
              });
            }
            const observed = yield* stats;
            expect(observed.hosts).toEqual([
              "allowed.example.test:8091",
              "allowed.example.test:8091",
            ]);
            expect(observed.blockedConnections).toBe(0);
          }
          const collector =
            (restart ? runtime : initialRuntime) === "executor-host"
              ? "http://127.0.0.1:4318"
              : (yield* run(["exec", id, "cat", "/app/data/diagnostics/collector.json"]).pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(
                      Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
                    ),
                  ),
                )).url;
          const delivered = yield* run([
            "run",
            "--rm",
            "--network",
            `container:${id}`,
            "node:24-bookworm-slim",
            "node",
            "-e",
            "fetch(process.argv[1]).then(r => r.text()).then(text => process.stdout.write(text))",
            `${collector}/api/traces/${trace}/spans`,
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
                  span.tags["service.version"] === expectedVersion,
              )
                ? Effect.succeed(trace)
                : Effect.fail("Released version has not reached the collector"),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 30 }),
          );
          expect(
            delivered.data.some(({ span }) => span.tags["service.version"] === expectedVersion),
          ).toBe(true);
          if (!restart) beforeRestartTrace = trace;
          else if (runtime === "executor-host") {
            expect(beforeRestartTrace).toBeDefined();
            const discarded = yield* run([
              "run",
              "--rm",
              "--network",
              `container:${id}`,
              "node:24-bookworm-slim",
              "node",
              "-e",
              "fetch(process.argv[1]).then(r => process.stdout.write(String(r.status)))",
              `${collector}/api/traces/${beforeRestartTrace}`,
            ]);
            expect(
              discarded.trim(),
              "Motel resets independently while product state is retained",
            ).toBe("404");
            expect((yield* run(["exec", id, "/app/workerd", "--version"])).trim()).toBe(
              "workerd 2026-09-01",
            );
            expect(
              yield* processes.exitCode(
                ChildProcess.make("docker", [
                  "exec",
                  id,
                  "sh",
                  "-c",
                  "test ! -e /usr/local/bin/bun && test ! -L /usr/local/bin/bun && test ! -e /app/motel/bun",
                ]),
              ),
              "the image contains no Bun runtime",
            ).toBe(0);
          }

          const called = yield* request(
            `${prefix}/apps/${app.id}/tools/call`,
            { profile: profile.id, tool: "queries.check", input: {} },
            cookie,
          );
          expect(called.status).toBe(200);
          expect(yield* driver("query response", () => called.json())).toBe(true);
          const workflow = yield* request(
            `${prefix}/apps/${app.id}/workflow-runs`,
            { profile: profile.id, workflow: "check", input: {}, key: randomUUID() },
            cookie,
          );
          expect(
            workflow.status,
            yield* driver("start workflow", () => workflow.clone().text()),
          ).toBe(200);
          const workflowRun = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ id: Schema.String }),
          )(yield* driver("workflow run", () => workflow.json()));
          const completed = yield* request(
            `${prefix}/apps/${app.id}/workflow-runs/${workflowRun.id}`,
            undefined,
            cookie,
          ).pipe(
            Effect.flatMap((response) => driver("workflow status", () => response.json())),
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  status: Schema.String,
                  output: Schema.optionalKey(Schema.Json),
                }),
              ),
            ),
            Effect.flatMap((run) =>
              run.status === "complete" ? Effect.succeed(run) : Effect.fail(run),
            ),
            Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }),
          );
          expect(completed.output, "workflow callbacks retain the selected encrypted account").toBe(
            true,
          );
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
          const messages = yield* request(
            `${prefix}/apps/${app.id}/tools/call`,
            { profile: profile.id, tool: "queries.messages", input: {} },
            cookie,
          );
          expect(messages.status).toBe(200);
          expect(yield* driver("retained app data", () => messages.json())).toEqual([
            "Retained app data",
          ]);
          const ui = yield* request(`${prefix}/apps/${app.id}/ui`, undefined, cookie);
          expect(ui.status).toBe(200);
          expect(yield* driver("compiled app UI", () => ui.json())).toEqual({
            status: "ready",
            url: expect.stringContaining("http"),
          });
        }
        if (mode === "local" && nativeBackup !== undefined) {
          const updated = yield* request(
            "/api/auth/update-user",
            { name: "Written after migration" },
            cookie,
          );
          expect(updated.status).toBe(200);
          yield* run(["stop", "--time", "15", id]);
          yield* run([
            "run",
            "--rm",
            "--volumes-from",
            id,
            image,
            "executor-host",
            "export",
            "/app/data/rollback.tar",
          ]);
          const restored = yield* run([
            "run",
            "--rm",
            "--volumes-from",
            id,
            "--entrypoint",
            initialRuntime,
            initialImage,
            "-e",
            `const {PGlite}=require("@electric-sql/pglite");const fs=require("node:fs");
(async()=>{const pg=new PGlite({loadDataDir:new Blob([fs.readFileSync("/app/data/rollback.tar")])});await pg.waitReady;
const result=await pg.query('SELECT name FROM "user"');await pg.close();process.stdout.write(JSON.stringify(result.rows));})().catch(()=>process.exit(1));`,
          ]);
          expect(
            yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String }))),
            )(restored),
            "rollback retains writes made after migration",
          ).toEqual([{ name: "Written after migration" }]);
          expect(yield* legacyDigest(), "export leaves the original backup intact").toBe(
            nativeBackup,
          );
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
