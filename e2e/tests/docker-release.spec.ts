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
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { driver } from "../support/platform.ts";
import { authorizeBrowserMcp } from "../support/mcp-oauth.ts";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { appsManifest, withApps } from "../support/apps-release.ts";
import { containerNpmRegistry } from "../support/npm-registry.ts";

/**
 * `workerd --version` prints the release date of the workerd the checkout pins, which the image
 * ships: 1.20260918.1 prints `workerd 2026-09-18`.
 */
const pinnedWorkerd = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const manifest = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({ devDependencies: Schema.Struct({ workerd: Schema.String }) }),
    ),
  )(yield* fs.readFileString("package.json"));
  return `workerd ${manifest.devDependencies.workerd.replace(/^\d+\.(\d{4})(\d{2})(\d{2})\.\d+$/, "$1-$2-$3")}`;
});

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
        const registry = yield* containerNpmRegistry;
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
          // Release scenarios never send product analytics, even from an image with a baked key.
          DO_NOT_TRACK: "1",
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
              ...registry.docker,
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
                content: `import { defineApp, defineProvider, secrets, string, query, mutation, workflow, object, router } from "apps";
import isNumber from "is-number";
const service = defineProvider({ name: "Release test", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { service } }, async ({ accounts }) => ({
  tools: router({
    check: query({ input: object({}) }, async () => isNumber("2") && accounts.service.fields.token === "synthetic-release-token"),
    messages: query({ input: object({}) }, async ({ sql }) => sql.exec("SELECT body FROM messages ORDER BY seq").toArray().map(row => row.body)),
    save: mutation({ input: object({ body: string() }) }, async ({ sql }, input) => { sql.exec("INSERT INTO messages (body) VALUES (?)", input.body); return input.body; }),
  }),
  workflows: { check: workflow({ input: object({}) }, async (ctx) =>
    ctx.step.do("credential", async (step) => step.accounts.service.fields.token === "synthetic-release-token")) }
}));`,
              },
              {
                path: "migrations/0001_messages.sql",
                content:
                  "CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);\n",
              },
              {
                path: "package.json",
                content: JSON.stringify({ dependencies: withApps({ "is-number": "7.0.0" }) }),
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
          {
            profile: profile.id,
            tool: "save",
            kind: "mutation",
            input: { body: "Retained app data" },
          },
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
              Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
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
const requests = [];
let blockedConnections = 0;
net.createServer(socket => { blockedConnections++; socket.destroy(); }).listen(8092, "::");
http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/stats") return response.end(JSON.stringify({ requests, blockedConnections }));
  requests.push(request.method + " " + request.headers.host + request.url);
  if (request.url === "/redirect") {
    response.writeHead(302, { location: "https://blocked.example.test:8092/mcp" }).end();
    return;
  }
  if (request.method !== "POST" || request.url !== "/mcp") return response.writeHead(404).end();
  // A public MCP server: anonymous initialization and tool listing succeed, so quick add needs
  // no account. Each answer echoes its request's id, as JSON-RPC requires.
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const message = JSON.parse(body);
    if (message.id === undefined) return response.writeHead(202).end();
    response.end(JSON.stringify({
      jsonrpc: "2.0", id: message.id,
      result: message.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "Release network fixture", version: "1.0.0" } }
        : { tools: [] }
    }));
  });
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
                      requests: Schema.Array(Schema.String),
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
                  kind: "mcp",
                  name: `Allowed import ${Number(restart)}`,
                  url: "http://allowed.example.test:8091/mcp",
                },
              },
              cookie,
            );
            expect(
              imported.status,
              yield* driver("allowed import", () => imported.clone().text()),
            ).toBe(200);
            for (const url of [
              "https://blocked.example.test:8092/mcp",
              "http://allowed.example.test:8091/redirect",
            ]) {
              const refused = yield* request(
                `${prefix}/apps/import`,
                {
                  source: { kind: "mcp", name: "Blocked import", url },
                },
                cookie,
              );
              expect(yield* driver("refused import", () => refused.json())).toMatchObject({
                _tag: "CatalogImportFailed",
              });
            }
            const observed = yield* stats;
            // The allowed import's anonymous check, then one request to the redirect that was
            // refused without following it. The blocked host was never contacted.
            expect(observed.requests).toEqual([
              "POST allowed.example.test:8091/mcp",
              "POST allowed.example.test:8091/mcp",
              "POST allowed.example.test:8091/mcp",
              "GET allowed.example.test:8091/.well-known/oauth-protected-resource/mcp",
              "GET allowed.example.test:8091/.well-known/oauth-protected-resource",
              "POST allowed.example.test:8091/redirect",
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
              yield* pinnedWorkerd,
            );
            // The collector shares the product's memory limit. It holds at most four exports of
            // 16 MiB in flight and refuses beyond that; the product's own exports fit.
            const ingest = yield* run([
              "run",
              "--rm",
              "--network",
              `container:${id}`,
              "node:24-bookworm-slim",
              "node",
              "-e",
              "fetch(process.argv[1]).then(r => r.text()).then(text => process.stdout.write(text))",
              `${collector}/api/ingest`,
            ]).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.fromJsonString(
                    Schema.Struct({
                      maxPending: Schema.Number,
                      maxBytes: Schema.Number,
                      refused: Schema.Struct({
                        queueFull: Schema.Number,
                        tooLarge: Schema.Number,
                        invalid: Schema.Number,
                        storeFailed: Schema.Number,
                      }),
                    }),
                  ),
                ),
              ),
            );
            expect(ingest).toEqual({
              maxPending: 4,
              maxBytes: 16 * 1024 * 1024,
              refused: { queueFull: 0, tooLarge: 0, invalid: 0, storeFailed: 0 },
            });
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
            { profile: profile.id, tool: "check", kind: "query", input: {} },
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
                          code: `return await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(profile.id)}].check({})`,
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
            { profile: profile.id, tool: "messages", kind: "query", input: {} },
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

// A tailnet name such as nexus.<tailnet>.ts.net resolves into 100.64.0.0/10. App isolates
// may reach only public addresses, so the built-in Executor app must reach its own dashboard
// origin without the network. The runner reaches the published port and sends the tailnet
// Host header, so the same case works with Docker Desktop, OrbStack and Linux Docker.
it.live("released image serves management tools at a tailnet origin with private fetch off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const image = yield* Config.String("EXECUTOR_E2E_DOCKER_IMAGE");
      const run = (args: readonly string[], env: Record<string, string> = {}) =>
        processes.string(
          ChildProcess.make("docker", args, {
            env,
            extendEnv: true,
            stderr: args[0] === "logs" ? "pipe" : "inherit",
          }),
          { includeStderr: args[0] === "logs" },
        );
      const id = `selfhost-e2e-${randomBytes(6).toString("hex")}`;
      const registry = yield* containerNpmRegistry;
      // Shared CGNAT space, the same range Tailscale assigns. Vary the subnet per run.
      const subnet = `100.64.${64 + (randomBytes(1).readUInt8(0) % 190)}`;
      const address = `${subnet}.10`;
      const containerPort = 8080;
      const hostname = "nexus.example.ts.net";
      const origin = `http://${hostname}:${containerPort}`;
      // A public-looking name for the same private address, which no name check catches.
      const disguised = "intranet.example.com";
      const port = yield* Effect.scoped(
        Effect.gen(function* () {
          for (let candidate = 4431; candidate <= 4439; candidate++) {
            const listener = createServer();
            const free = yield* driver(
              "probe release port",
              () =>
                new Promise<boolean>((resolve) => {
                  listener.once("error", () => resolve(false));
                  listener.listen(candidate, "127.0.0.1", () =>
                    listener.close(() => resolve(true)),
                  );
                }),
            );
            if (free) return candidate;
          }
          return yield* Effect.fail(new Error("Ports 4431-4439 are all in use"));
        }),
      );
      yield* Effect.acquireRelease(
        run(["network", "create", "--subnet", `${subnet}.0/24`, id]),
        () => run(["network", "rm", id]).pipe(Effect.orDie),
      );
      const environment: Record<string, string> = {
        // Release scenarios never send product analytics, even from an image with a baked key.
        DO_NOT_TRACK: "1",
        PORT: String(containerPort),
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        // A synthetic registry that shares the container's network namespace.
        EXECUTOR_REGISTRY_URL: "http://127.0.0.1:8093",
      };
      yield* Effect.acquireRelease(
        run(
          [
            "run",
            "--detach",
            "--name",
            id,
            "--init",
            "--network",
            id,
            "--ip",
            address,
            "--add-host",
            `${hostname}:${address}`,
            "--add-host",
            `${disguised}:${address}`,
            "--publish",
            `127.0.0.1:${port}:${containerPort}`,
            // EXECUTOR_APPS_ALLOW_PRIVATE_FETCH stays unset: the default is under test.
            ...Object.keys(environment).flatMap((name) => ["--env", name]),
            ...registry.docker,
            image,
          ],
          environment,
        ),
        // An anonymous data volume is removed with the container.
        () => run(["rm", "--force", "--volumes", id]).pipe(Effect.orDie),
      );
      yield* Effect.addFinalizer((exit) =>
        Exit.isFailure(exit)
          ? run(["logs", id]).pipe(Effect.flatMap(Console.error), Effect.ignore)
          : Effect.void,
      );
      // Node's fetch replaces a Host header, so send requests through node:http instead.
      const hostFetch: typeof fetch = (input, init) => {
        const outgoing = new Request(input, init);
        const url = new URL(outgoing.url);
        const sent: Record<string, string> = {};
        outgoing.headers.forEach((value, name) => {
          sent[name] = value;
        });
        return outgoing.arrayBuffer().then(
          (body) =>
            new Promise<Response>((resolve, reject) => {
              const pending = httpRequest(
                {
                  host: "127.0.0.1",
                  port,
                  method: outgoing.method,
                  path: `${url.pathname}${url.search}`,
                  headers: { ...sent, host: url.host },
                  signal: outgoing.signal,
                },
                (incoming) => {
                  const status = incoming.statusCode;
                  if (status === undefined) return reject(new Error("Response has no status"));
                  const headers = new Headers();
                  for (const [name, value] of Object.entries(incoming.headers))
                    for (const item of typeof value === "string" ? [value] : (value ?? []))
                      headers.append(name, item);
                  const empty = status === 204 || status === 304 || outgoing.method === "HEAD";
                  if (empty) incoming.resume();
                  resolve(
                    new Response(
                      empty
                        ? null
                        : new ReadableStream<Uint8Array>({
                            start(controller) {
                              incoming.on("data", (chunk: Buffer) =>
                                controller.enqueue(new Uint8Array(chunk)),
                              );
                              incoming.once("end", () => controller.close());
                              incoming.once("error", (error) => controller.error(error));
                            },
                            cancel() {
                              incoming.destroy();
                            },
                          }),
                      { status, headers },
                    ),
                  );
                },
              );
              pending.once("error", reject);
              pending.end(body.byteLength === 0 ? undefined : Buffer.from(body));
            }),
        );
      };
      const request = (route: string, data?: unknown, cookie?: string) =>
        driver("tailnet image HTTP request", () =>
          hostFetch(`${origin}${route}`, {
            method: data === undefined ? "GET" : "POST",
            headers: {
              origin,
              "content-type": "application/json",
              ...(cookie === undefined ? {} : { cookie }),
            },
            ...(data === undefined ? {} : { body: JSON.stringify(data) }),
          }),
        );
      yield* request("/health").pipe(
        Effect.flatMap((r) => (r.status === 200 ? Effect.void : Effect.fail("not ready"))),
        Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 200 }),
      );
      const setup = yield* request("/api/auth/self-host/setup", {
        name: "Tailnet Owner",
        email: "tailnet@example.test",
        password: "Synthetic-tailnet-password-123!",
        organizationName: "Tailnet lab",
      });
      expect(setup.status).toBe(200);
      const cookie = setup.headers
        .getSetCookie()
        .map((part) => part.split(";")[0])
        .join("; ");
      const organizations = yield* request("/api/auth/organization/list", undefined, cookie);
      expect(organizations.status).toBe(200);
      const [organization] = yield* Schema.decodeUnknownEffect(
        Schema.NonEmptyArray(Schema.Struct({ id: Schema.String })),
      )(yield* driver("organization response", () => organizations.json()));
      const prefix = `/api/organizations/${organization.id}`;
      // workerd rejects some fetch redirect modes before sending. Each name selects one registry
      // response, and the catalog must report it without following a redirect.
      const appRegistry = `${id}-registry`;
      yield* Effect.acquireRelease(
        run([
          "run",
          "--detach",
          "--name",
          appRegistry,
          "--network",
          `container:${id}`,
          "node:24-bookworm-slim",
          "node",
          "-e",
          `
const http = require("node:http");
const paths = [];
const list = JSON.stringify([{ name: "@fixture/example", commit: "${"a".repeat(40)}", description: "A shared example", publishedAt: "2026-01-01T00:00:00.000Z" }]);
http.createServer((request, response) => {
  const url = new URL(request.url, "http://registry.invalid");
  if (url.pathname === "/stats") return response.end(JSON.stringify(paths));
  paths.push(url.pathname + url.search);
  const name = url.searchParams.get("name");
  if (name === "@fixture/moved") return response.writeHead(302, { location: "/elsewhere" }).end();
  if (name === "@fixture/down") return response.writeHead(503, { "content-type": "text/plain" }).end("unavailable");
  if (name === "@fixture/garbled") return response.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
  if (name === "@fixture/missing")
    return response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ _tag: "RegistryError", reason: "not-found" }));
  response.writeHead(200, { "content-type": "application/json" }).end(list);
}).listen(8093, "127.0.0.1");
`,
        ]),
        () => run(["rm", "--force", appRegistry]).pipe(Effect.orDie),
      );
      const registryPaths = run([
        "exec",
        appRegistry,
        "node",
        "-e",
        'fetch("http://127.0.0.1:8093/stats").then(r => r.text()).then(text => process.stdout.write(text))',
      ]).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String))),
        ),
      );
      yield* registryPaths.pipe(
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }),
      );
      const catalog = (name?: string) =>
        request(
          `${prefix}/app-publications${name === undefined ? "" : `?name=${encodeURIComponent(name)}`}`,
          undefined,
          cookie,
        ).pipe(
          Effect.flatMap((response) =>
            driver("catalog response", () => response.json()).pipe(
              Effect.map((body: unknown) => ({ status: response.status, body })),
            ),
          ),
        );
      expect(yield* catalog()).toEqual({
        status: 200,
        body: [
          {
            name: "@fixture/example",
            commit: "a".repeat(40),
            description: "A shared example",
            publishedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      // Each failure states its cause in a message Executor derives from the reason.
      const failures = {
        "@fixture/moved": {
          reason: "status",
          status: 302,
          message: "The public app registry responded with HTTP 302.",
        },
        "@fixture/down": {
          reason: "status",
          status: 503,
          message: "The public app registry responded with HTTP 503.",
        },
        "@fixture/garbled": {
          reason: "invalid-response",
          message: "The public app registry returned a response Executor could not read.",
        },
        "@fixture/missing": {
          reason: "not-found",
          message: "The public app listing or its selected commit does not exist.",
        },
      };
      for (const [name, failure] of Object.entries(failures))
        expect(yield* catalog(name), name).toEqual({
          status: 400,
          body: { _tag: "RegistryError", ...failure },
        });
      expect(yield* registryPaths, "redirects are not followed").toEqual(
        [undefined, ...Object.keys(failures)].map(
          (name) =>
            `/api/registry/apps${name === undefined ? "" : `?name=${encodeURIComponent(name)}`}`,
        ),
      );
      yield* run(["kill", appRegistry]);
      expect(yield* catalog("@fixture/example"), "an unreachable registry").toEqual({
        status: 400,
        body: {
          _tag: "RegistryError",
          reason: "network",
          message: "Executor could not reach the public app registry. Try again.",
        },
      });
      const deployed = yield* request(
        `${prefix}/apps/deploy`,
        {
          name: "Egress probe",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, query, object, string, router } from "apps";
export default defineApp({ accounts: {} }, async () => ({
  tools: router({
    probe: query({ input: object({ url: string() }) }, async (ctx, input) => {
      try { return "reached:" + (await ctx.fetch(input.url)).status; }
      catch (error) { return "refused:" + (error instanceof Error ? error.message : String(error)); }
    }),
  })
}));`,
            },
            appsManifest,
          ],
        },
        cookie,
      );
      expect(deployed.status, yield* driver("deploy probe", () => deployed.clone().text())).toBe(
        200,
      );
      const app = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: Schema.String, slug: Schema.String }),
      )(yield* driver("probe app", () => deployed.json()));
      const created = yield* request(
        `${prefix}/apps/${app.id}/profiles`,
        { accounts: {}, idempotencyKey: randomUUID() },
        cookie,
      );
      expect(created.status).toBe(200);
      const probeProfile = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
        yield* driver("probe profile", () => created.json()),
      );
      // Setup provisions the built-in Executor app in the background.
      const executorProfile = yield* Effect.gen(function* () {
        const inventory = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            apps: Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String })),
          }),
        )(
          yield* request(`${prefix}/inventory`, undefined, cookie).pipe(
            Effect.flatMap((response) => driver("inventory", () => response.json())),
          ),
        );
        const executor = inventory.apps.find((item) => item.slug === "executor");
        if (executor === undefined) return yield* Effect.fail("Executor app pending");
        const profiles = yield* Schema.decodeUnknownEffect(
          Schema.NonEmptyArray(Schema.Struct({ id: Schema.String })),
        )(
          yield* request(`${prefix}/apps/${executor.id}/profiles`, undefined, cookie).pipe(
            Effect.flatMap((response) => driver("Executor profiles", () => response.json())),
          ),
        );
        return profiles[0];
      }).pipe(Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }));
      const keyResponse = yield* request(
        "/api/auth/api-key/create",
        { name: "Tailnet MCP check" },
        cookie,
      );
      expect(keyResponse.status).toBe(200);
      const key = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ key: Schema.RedactedFromValue(Schema.String) }),
      )(yield* driver("MCP key", () => keyResponse.json()));
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new Client({ name: "tailnet-release", version: "1" })),
        (client) => driver("close tailnet MCP client", () => client.close()).pipe(Effect.orDie),
      );
      const transport: Omit<StreamableHTTPClientTransport, "sessionId"> =
        new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
          requestInit: {
            headers: {
              authorization: `Bearer ${Redacted.value(key.key)}`,
              "x-executor-organization": organization.id,
            },
          },
          fetch: hostFetch,
        });
      yield* driver("connect to the tailnet image over MCP", () => client.connect(transport));
      const execute = (operation: string, code: string) =>
        driver(operation, (signal) =>
          client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
        ).pipe(
          Effect.flatMap((result) =>
            Schema.decodeUnknownEffect(
              Schema.Struct({
                status: Schema.Literal("completed"),
                execution: Schema.Struct({
                  ok: Schema.Boolean,
                  value: Schema.optional(Schema.Unknown),
                  error: Schema.optional(Schema.Unknown),
                }),
              }),
            )(result.structuredContent),
          ),
          Effect.map(({ execution }) => execution),
        );
      const source = yield* execute(
        "read app source through the built-in Executor app",
        `return await tools.executor.profiles[${JSON.stringify(executorProfile.id)}].appManagement.source(${JSON.stringify({ path: { organization: organization.id, app: app.id } })})`,
      );
      expect(
        source,
        `the built-in Executor app reaches its own dashboard at a private-resolving origin: ${JSON.stringify(source.error)}`,
      ).toMatchObject({
        ok: true,
        value: { files: expect.arrayContaining([expect.objectContaining({ path: "index.ts" })]) },
      });
      const probe = (url: string) =>
        execute(
          `authored app fetches ${url}`,
          `return await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(probeProfile.id)}].probe(${JSON.stringify({ url })})`,
        );
      // The same listener on its private address is not the dashboard origin.
      const refused = yield* probe(`http://${address}:${containerPort}/health`);
      expect(refused.ok).toBe(true);
      // Executor refuses the address by name, before the public-only network would.
      expect(refused.value, "private app fetch stays off by default").toMatch(
        /^refused:Executor refused a request to 100\.64\.[\d.]+:\d+: apps on this instance can reach only public addresses/,
      );
      // A public name passes Executor's check, and the public-only network refuses its address.
      const resolved = yield* probe(`http://${disguised}:${containerPort}/health`);
      expect(resolved.ok).toBe(true);
      expect(resolved.value, "the network refuses a public name's private address").toMatch(
        /^refused:/,
      );
      expect(resolved.value).not.toMatch(/^refused:Executor refused/);
      expect(yield* probe(`${origin}/health`), "authored apps reach the dashboard origin").toEqual({
        ok: true,
        value: "reached:200",
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

/** One call of a probe app, reporting its isolate and how many calls that isolate has served. */
type Probe = Effect.Effect<{ readonly isolate: string; readonly calls: number }, unknown>;

/**
 * The released image reads `EXECUTOR_APP_WORKERS` through its Go host into the apps Worker's
 * workerd binding. A positive value bounds the app Workers kept loaded, an unset value applies the
 * default of 32 and an invalid value stops the server before it starts. Each probe app reports an
 * identifier from its module state, so a Worker that was unloaded and loaded again reports a new
 * identifier and no earlier calls. The limit also counts the built-in Executor app's Worker, so
 * the probes start only after its background setup has finished.
 */
it.live(
  "released image keeps at most EXECUTOR_APP_WORKERS app Workers loaded",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const image = yield* Config.String("EXECUTOR_E2E_DOCKER_IMAGE");
        const run = (args: readonly string[], env: Record<string, string> = {}) =>
          processes.string(
            ChildProcess.make("docker", args, {
              env,
              extendEnv: true,
              stderr: args[0] === "logs" ? "pipe" : "inherit",
            }),
            { includeStderr: args[0] === "logs" },
          );
        const freePort = driver(
          "allocate port",
          () =>
            new Promise<number>((resolve, reject) => {
              const listener = createServer();
              listener.once("error", reject);
              listener.listen(0, "127.0.0.1", () => {
                const address = listener.address();
                listener.close(() =>
                  address === null || typeof address === "string"
                    ? reject(new Error("No test port"))
                    : resolve(address.port),
                );
              });
            }),
        );
        const containerPort = 8080;
        const registry = yield* containerNpmRegistry;
        /** Start the image with an app Worker limit, or none, in its own container. */
        const start = (limit: string | undefined) =>
          Effect.gen(function* () {
            const id = `executor-app-workers-${randomBytes(6).toString("hex")}`;
            const port = yield* freePort;
            const origin = `http://localhost:${port}`;
            const environment: Record<string, string> = {
              // Release scenarios never send product analytics, even from an image with a baked key.
              DO_NOT_TRACK: "1",
              PORT: String(containerPort),
              BETTER_AUTH_URL: origin,
              BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
              EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
              ...(limit === undefined ? {} : { EXECUTOR_APP_WORKERS: limit }),
            };
            yield* Effect.acquireRelease(
              run(
                [
                  "run",
                  "--detach",
                  "--name",
                  id,
                  "--init",
                  "--publish",
                  `127.0.0.1:${port}:${containerPort}`,
                  ...Object.keys(environment).flatMap((name) => ["--env", name]),
                  ...registry.docker,
                  image,
                ],
                environment,
              ),
              // An anonymous data volume is removed with the container.
              () => run(["rm", "--force", "--volumes", id]).pipe(Effect.orDie),
            );
            return { id, origin, address: `http://127.0.0.1:${port}` };
          });

        // An invalid limit stops the server with a clear message instead of using a default.
        for (const invalid of ["0", "many"]) {
          const container = yield* start(invalid);
          const code = (yield* run(["wait", container.id]).pipe(
            Effect.timeoutOrElse({
              duration: "60 seconds",
              orElse: () =>
                Effect.fail(new Error(`EXECUTOR_APP_WORKERS=${invalid} did not stop the server`)),
            }),
          )).trim();
          expect(code, `EXECUTOR_APP_WORKERS=${invalid} stops the server`).not.toBe("0");
          expect(yield* run(["logs", container.id])).toContain(
            "EXECUTOR_APP_WORKERS must be a positive integer",
          );
        }

        /** An owner, an organization and probe apps without accounts on a running container. */
        const serve = (limit: string | undefined, apps: number) =>
          Effect.gen(function* () {
            const container = yield* start(limit);
            yield* Effect.addFinalizer((exit) =>
              Exit.isFailure(exit)
                ? run(["logs", container.id]).pipe(Effect.flatMap(Console.error), Effect.ignore)
                : Effect.void,
            );
            const request = (route: string, data?: unknown, cookie?: string) =>
              driver("app Worker limit HTTP request", () =>
                fetch(`${container.address}${route}`, {
                  method: data === undefined ? "GET" : "POST",
                  headers: {
                    origin: container.origin,
                    "content-type": "application/json",
                    ...(cookie === undefined ? {} : { cookie }),
                  },
                  ...(data === undefined ? {} : { body: JSON.stringify(data) }),
                }),
              );
            const json = <A>(schema: Schema.ConstraintDecoder<A, never>, response: Response) =>
              driver("app Worker limit response", () => response.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(schema)),
              );
            yield* request("/health").pipe(
              Effect.flatMap((r) => (r.status === 200 ? Effect.void : Effect.fail("not ready"))),
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 200 }),
            );
            const setup = yield* request("/api/auth/self-host/setup", {
              name: "Worker Limit Owner",
              email: "worker-limit@example.test",
              password: "Synthetic-worker-limit-password-123!",
              organizationName: "Worker limit lab",
            });
            expect(setup.status).toBe(200);
            const cookie = setup.headers
              .getSetCookie()
              .map((part) => part.split(";")[0])
              .join("; ");
            const [organization] = yield* json(
              Schema.NonEmptyArray(Schema.Struct({ id: Schema.String })),
              yield* request("/api/auth/organization/list", undefined, cookie),
            );
            const prefix = `/api/organizations/${organization.id}`;
            // Setup installs the built-in Executor app and the owner's profile of it in the
            // background. That profile's setup loads the app's Worker, which under a low limit
            // unloads an idle probe Worker, so it must finish before the probes are deployed.
            const executorProfiles = yield* request(`${prefix}/inventory`, undefined, cookie).pipe(
              Effect.flatMap((response) =>
                json(
                  Schema.Struct({
                    apps: Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String })),
                    profiles: Schema.Array(
                      Schema.Struct({ app: Schema.String, status: Schema.String }),
                    ),
                  }),
                  response,
                ),
              ),
              Effect.flatMap(({ apps, profiles }) => {
                const executor = apps.find((app) => app.slug === "executor");
                const setup =
                  executor === undefined
                    ? []
                    : profiles.filter((profile) => profile.app === executor.id);
                return setup.length === 0 || setup.some((profile) => profile.status === "pending")
                  ? Effect.fail(new Error("Executor app setup has not finished"))
                  : Effect.succeed(setup);
              }),
              Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 150 }),
            );
            // A profile that is not ready retries its setup later and loads the Worker again.
            for (const profile of executorProfiles)
              expect(profile.status, "the built-in Executor app is set up").toBe("ready");
            const probes: Array<Probe> = [];
            for (let index = 0; index < apps; index++) {
              const deployed = yield* request(
                `${prefix}/apps/deploy`,
                {
                  name: `Worker limit ${index}`,
                  files: [
                    {
                      path: "index.ts",
                      content: `import { defineApp, query, object, router } from "apps";
let isolate;
let calls = 0;
export default defineApp({ accounts: {} }, async () => ({
  tools: router({
    probe: query({ input: object({}) }, async () => {
      isolate ??= crypto.randomUUID();
      calls++;
      return { isolate, calls };
    }),
  }),
}));`,
                    },
                    appsManifest,
                  ],
                },
                cookie,
              );
              expect(
                deployed.status,
                yield* driver("deploy probe", () => deployed.clone().text()),
              ).toBe(200);
              const app = yield* json(Schema.Struct({ id: Schema.String }), deployed);
              const profile = yield* json(
                Schema.Struct({ id: Schema.String }),
                yield* request(
                  `${prefix}/apps/${app.id}/profiles`,
                  { accounts: {}, idempotencyKey: randomUUID() },
                  cookie,
                ),
              );
              // Profile setup discovers the app in the background; let it finish before the calls.
              yield* request(
                `${prefix}/apps/${app.id}/profiles/${profile.id}`,
                undefined,
                cookie,
              ).pipe(
                Effect.flatMap((response) =>
                  json(Schema.Struct({ status: Schema.String }), response),
                ),
                Effect.flatMap((current) =>
                  current.status === "pending"
                    ? Effect.fail(new Error("Profile setup has not finished"))
                    : Effect.void,
                ),
                Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 150 }),
              );
              probes.push(
                request(
                  `${prefix}/apps/${app.id}/tools/call`,
                  { profile: profile.id, tool: "probe", input: {} },
                  cookie,
                ).pipe(
                  Effect.tap((response) =>
                    Effect.sync(() => expect(response.status, `probe ${index}`).toBe(200)),
                  ),
                  Effect.flatMap((response) =>
                    json(Schema.Struct({ isolate: Schema.String, calls: Schema.Number }), response),
                  ),
                ),
              );
            }
            return probes;
          });

        // A limit of one: calling a second app unloads the first, which then loads again.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const [first, second] = (yield* serve("1", 2)) as [Probe, Probe];
            const before = yield* first;
            expect((yield* first).isolate, "a warm call reuses the loaded Worker").toBe(
              before.isolate,
            );
            const other = yield* second;
            const back = yield* first;
            expect(back.isolate, "the first Worker was unloaded above the limit").not.toBe(
              before.isolate,
            );
            expect(back.calls).toBe(1);
            expect((yield* second).isolate, "the second Worker was unloaded in turn").not.toBe(
              other.isolate,
            );
          }),
        );

        // No limit set: the default keeps 32 Workers loaded and unloads the 33rd most recent.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const probes = yield* serve(undefined, 33);
            const first: Array<{ isolate: string; calls: number }> = [];
            for (const probe of probes) first.push(yield* probe);
            // Newest first, so each call reuses a loaded Worker and unloads none.
            for (let index = probes.length - 1; index >= 1; index--) {
              const again = yield* probes[index]!;
              expect(again.isolate, `app ${index} stayed loaded`).toBe(first[index]!.isolate);
              expect(again.calls).toBe(2);
            }
            const oldest = yield* probes[0]!;
            expect(oldest.isolate, "the least recently used Worker was unloaded").not.toBe(
              first[0]!.isolate,
            );
            expect(oldest.calls).toBe(1);
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  300_000,
);
