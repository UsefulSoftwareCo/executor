import { randomUUID } from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Clock,
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
import { connectionsPath } from "../support/app-accounts.ts";
import { currentClient } from "../support/api.ts";
import { releaseNetwork } from "../support/release-networks.ts";
import { stalledPageReport } from "../support/stalled-page.ts";

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
                EXECUTOR_APPS_ALLOW_PRIVATE_ORIGINS: '["http://allowed.example.test:8091"]',
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
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts } }) => ({
  tools: router({
    check: query({ input: object({}) }, async () => isNumber("2") && accounts.service.fields.token === "synthetic-release-token"),
    messages: query({ input: object({}) }, async ({ sql }) => sql.exec("SELECT body FROM messages ORDER BY seq").toArray().map(row => row.body)),
    save: mutation({ input: object({ body: string() }) }, async ({ sql }, input) => { sql.exec("INSERT INTO messages (body) VALUES (?)", input.body); return input.body; }),
  }),
  workflows: { check: workflow({ input: object({}) }, async (ctx) =>
    ctx.step.do("credential", async (step) => step.user.accounts.service.fields.token === "synthetic-release-token")) }
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
        expect(deployed.status, yield* driver("deploy result", () => deployed.clone().text())).toBe(
          200,
        );
        const app = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ id: Schema.String, slug: Schema.String }),
        )(yield* driver("deploy response", () => deployed.json()));
        const connectionResponse = yield* request(
          connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
          {},
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
        yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
          yield* driver("connected account", () => connected.json()),
        );
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
                const reportStall = stalledPageReport(page);
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
                yield* reportStall(
                  driver("sign-in reaches the intended organization", () =>
                    page.waitForURL(
                      (url) =>
                        url.origin === origin && url.pathname === `/org/${parsed[0].slug}/apps`,
                    ),
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
            const egress: Array<string> = [];
            if (restart) {
              const deployed = yield* request(
                `${prefix}/apps/deploy`,
                {
                  name: "Private origin probe",
                  files: [
                    {
                      path: "index.ts",
                      content: `import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, async () => ({
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
              expect(
                deployed.status,
                yield* driver("deploy private origin probe", () => deployed.clone().text()),
              ).toBe(200);
              const app = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
                yield* driver("private origin probe app", () => deployed.json()),
              );
              const probe = (url: string) =>
                request(
                  `${prefix}/apps/${app.id}/tools/call`,
                  { tool: "probe", kind: "query", input: { url } },
                  cookie,
                ).pipe(
                  Effect.flatMap((response) => driver(`probe ${url}`, () => response.json())),
                  Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)),
                );
              expect(
                yield* probe("http://allowed.example.test:8091/egress"),
                "an app reaches the private origin its operator lists",
              ).toBe("reached:404");
              const otherPort = "allowed.example.test:8092";
              expect(
                yield* probe(`http://${otherPort}/egress`),
                "a listed name on another port stays refused",
              ).toBe(
                `refused:Executor refused a request to ${otherPort}: apps on this instance can reach only public addresses, and ${otherPort} is a private, loopback or internal address. The request was not sent.`,
              );
              for (const url of [
                "https://blocked.example.test:8092/mcp",
                "http://allowed.example.test:8091/redirect",
              ]) {
                const blocked = yield* probe(url);
                expect(blocked, `the network refuses ${url}`).toMatch(/^refused:/);
                expect(blocked).not.toMatch(/^refused:Executor refused/);
              }
              egress.push(
                "GET allowed.example.test:8091/egress",
                "GET allowed.example.test:8091/redirect",
              );
            }
            const observed = yield* stats;
            expect(observed.requests).toEqual([
              "POST allowed.example.test:8091/mcp",
              "POST allowed.example.test:8091/mcp",
              "POST allowed.example.test:8091/mcp",
              "GET allowed.example.test:8091/.well-known/oauth-protected-resource/mcp",
              "GET allowed.example.test:8091/.well-known/oauth-protected-resource",
              "POST allowed.example.test:8091/redirect",
              ...egress,
            ]);
            expect(observed.blockedConnections).toBe(0);
          }
          const legacyCollector =
            restart || initialImage === image
              ? undefined
              : initialRuntime === "executor-host"
                ? "http://127.0.0.1:4318"
                : (yield* run(["exec", id, "cat", "/app/data/diagnostics/collector.json"]).pipe(
                    Effect.flatMap(
                      Schema.decodeUnknownEffect(
                        Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
                      ),
                    ),
                  )).url;
          const readCollector = (path: string) =>
            legacyCollector === undefined
              ? run(["exec", id, "executor-host", "telemetry", path])
              : run([
                  "run",
                  "--rm",
                  "--network",
                  `container:${id}`,
                  "node:24-bookworm-slim",
                  "node",
                  "-e",
                  "fetch(process.argv[1]).then(r => r.text()).then(text => process.stdout.write(text))",
                  `${legacyCollector}${path}`,
                ]);
          const spansOf = (traceId: string) =>
            readCollector(`/api/traces/${traceId}/spans`).pipe(
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
          const delivered = yield* spansOf(trace);
          expect(
            delivered.data.some(({ span }) => span.tags["service.version"] === expectedVersion),
          ).toBe(true);
          if (!restart) beforeRestartTrace = trace;
          else if (runtime === "executor-host") {
            expect(beforeRestartTrace).toBeDefined();
            const discarded = yield* run([
              "exec",
              id,
              "sh",
              "-c",
              'executor-host telemetry "$1" 2>&1 >/dev/null || true',
              "sh",
              `/api/traces/${beforeRestartTrace}`,
            ]);
            expect(
              discarded.trim(),
              "the collector's telemetry resets independently while product state is retained",
            ).toBe("Executor: the telemetry collector answered 404");
            expect((yield* run(["exec", id, "/app/workerd", "--version"])).trim()).toBe(
              yield* pinnedWorkerd,
            );
            const ingest = yield* readCollector("/api/ingest").pipe(
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
            const collectorProcess = run([
              "exec",
              id,
              "sh",
              "-c",
              'm=executor-collector; for p in /proc/[0-9]*; do case "$(cat "$p/cmdline" 2>/dev/null)" in "/app/$m"*) echo "${p#/proc/}";; esac; done',
            ]).pipe(Effect.map((output) => output.trim()));
            const firstCollector = yield* collectorProcess;
            expect(firstCollector).toMatch(/^\d+$/);
            const killed = yield* Clock.currentTimeMillis;
            yield* run(["exec", id, "sh", "-c", `kill ${firstCollector}`]);
            expect((yield* request("/health")).status).toBe(200);
            const restartedCollector = yield* collectorProcess.pipe(
              Effect.flatMap((pid) =>
                /^\d+$/.test(pid) && pid !== firstCollector
                  ? Effect.succeed(pid)
                  : Effect.fail("The collector has not restarted"),
              ),
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
            );
            expect(restartedCollector).not.toBe(firstCollector);
            expect(
              (yield* Clock.currentTimeMillis) - killed,
              "the host waits before restarting the collector",
            ).toBeGreaterThanOrEqual(1000);
            const afterRestart = randomBytes(16).toString("hex");
            expect((yield* request("/api/viewer", undefined, cookie, afterRestart)).status).toBe(
              200,
            );
            yield* spansOf(afterRestart);
            const pinFile = yield* (yield* Path.Path).fromFileUrl(
              new URL("../../apps/hosted/self-host/workerd.json", import.meta.url),
            );
            const pin = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Struct({ release: Schema.String })),
            )(yield* (yield* FileSystem.FileSystem).readFileString(pinFile));
            expect(
              (yield* run(["exec", id, "cat", "/app/runtime-packages.txt"])).split("\n"),
            ).toContain(`workerd@${pin.release}`);
            const workerdConfig = yield* run(["exec", id, "cat", "/app/workerd.capnp"]);
            for (const setting of [
              "idleIsolateGcDelayMs=10000",
              "pressureGcBudgetMs=100",
              "tcmallocBackgroundReleaseBytesPerSecond=8388608",
              "releaseMemoryAfterGc=true",
              'v8Flags=["--expose-gc","--no-flush-liftoff-code"]',
            ])
              expect(workerdConfig).toContain(setting);
            expect(workerdConfig).not.toContain("workerLoaderIdleTtlMs");
            expect(
              yield* processes.exitCode(
                ChildProcess.make("docker", [
                  "exec",
                  id,
                  "sh",
                  "-c",
                  "test ! -e /usr/local/bin/bun && test ! -L /usr/local/bin/bun",
                ]),
              ),
              "the image contains no Bun runtime",
            ).toBe(0);
          }

          const called = yield* request(
            `${prefix}/apps/${app.id}/tools/call`,
            { tool: "check", kind: "query", input: {} },
            cookie,
          );
          expect(called.status).toBe(200);
          expect(yield* driver("query response", () => called.json())).toBe(true);
          const workflow = yield* request(
            `${prefix}/apps/${app.id}/workflow-runs`,
            { workflow: "check", input: {}, key: randomUUID() },
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
                          code: `return await tools[${JSON.stringify(app.slug)}].check({})`,
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
            { tool: "messages", kind: "query", input: {} },
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
            name: "Image check",
            icon: false,
            menuBar: false,
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

it.live("released image keeps its collector out of apps' reach with private fetch on", () =>
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
      const id = `executor-collector-${randomBytes(6).toString("hex")}`;
      const registry = yield* containerNpmRegistry;
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
      const containerPort = 8080;
      const origin = `http://localhost:${port}`;
      const environment: Record<string, string> = {
        DO_NOT_TRACK: "1",
        PORT: String(containerPort),
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: "true",
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
        () => run(["rm", "--force", "--volumes", id]).pipe(Effect.orDie),
      );
      yield* Effect.addFinalizer((exit) =>
        Exit.isFailure(exit)
          ? run(["logs", id]).pipe(Effect.flatMap(Console.error), Effect.ignore)
          : Effect.void,
      );
      const request = (route: string, data?: unknown, cookie?: string, trace?: string) =>
        driver("collector image HTTP request", () =>
          fetch(`http://127.0.0.1:${port}${route}`, {
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
      yield* request("/health").pipe(
        Effect.flatMap((r) => (r.status === 200 ? Effect.void : Effect.fail("not ready"))),
        Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 200 }),
      );
      const setup = yield* request("/api/auth/self-host/setup", {
        name: "Collector Owner",
        email: "collector@example.test",
        password: "Synthetic-collector-password-123!",
        organizationName: "Collector lab",
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
      const deployed = yield* request(
        `${prefix}/apps/deploy`,
        {
          name: "Collector probe",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, async () => ({
  tools: router({
    probe: query({ input: object({ url: string(), body: string() }) }, async (ctx, input) => {
      try {
        const response = await ctx.fetch(input.url, input.body === "" ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: input.body });
        return "reached " + response.status + " " + (await response.text()).slice(0, 4000);
      } catch (error) { return "refused " + (error instanceof Error ? error.message : String(error)); }
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
      const app = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
        yield* driver("probe app", () => deployed.json()),
      );
      const probe = (url: string, body = "") =>
        request(
          `${prefix}/apps/${app.id}/tools/call`,
          { tool: "probe", kind: "query", input: { url, body } },
          cookie,
        ).pipe(
          Effect.flatMap((response) => driver(`probe ${url}`, () => response.json())),
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)),
        );
      const productTrace = randomBytes(16).toString("hex");
      expect((yield* request("/api/viewer", undefined, cookie, productTrace)).status).toBe(200);
      const telemetry = (path: string) => run(["exec", id, "executor-host", "telemetry", path]);
      const spans = (trace: string) =>
        telemetry(`/api/traces/${trace}/spans`).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  data: Schema.Array(
                    Schema.Struct({ span: Schema.Struct({ serviceName: Schema.String }) }),
                  ),
                }),
              ),
            ),
          ),
          Effect.flatMap((trace) =>
            trace.data.some(({ span }) => span.serviceName === "executor-selfhost")
              ? Effect.succeed(trace)
              : Effect.fail("The product's spans have not reached the collector"),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 30 }),
        );
      yield* spans(productTrace);
      const tcpTables = run(["exec", id, "cat", "/proc/net/tcp", "/proc/net/tcp6"]).pipe(
        Effect.map((table) =>
          table
            .split("\n")
            .map((line) => line.trim().split(/\s+/))
            .filter((fields) => /^[0-9A-F]+:[0-9A-F]{4}$/.test(fields[1] ?? "")),
        ),
      );
      const listening = (yield* tcpTables)
        .filter((fields) => fields[3] === "0A")
        .map((fields) => Number.parseInt(fields[1]!.split(":")[1]!, 16));
      const ports = [...new Set([...listening, 4318])].sort((a, b) => a - b);
      expect(ports).toContain(containerPort);
      const injectedTrace = randomBytes(16).toString("hex");
      const injected = JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: "executor-selfhost" } }],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: injectedTrace,
                    spanId: randomBytes(8).toString("hex"),
                    name: "injected by an app",
                    kind: 1,
                    startTimeUnixNano: "1700000000000000000",
                    endTimeUnixNano: "1700000000001000000",
                  },
                ],
              },
            ],
          },
        ],
      });
      const received = (result: string) => (result.startsWith("reached ") ? result : "");
      for (const listener of ports) {
        const base = `http://127.0.0.1:${listener}`;
        const read = yield* probe(`${base}/api/traces/${productTrace}/spans`);
        expect(
          received(read),
          `an app reads the product's traces on port ${listener}`,
        ).not.toContain(productTrace);
        const counters = yield* probe(`${base}/api/ingest`);
        expect(
          received(counters),
          `an app reads collector counters on port ${listener}`,
        ).not.toContain("maxPending");
        const written = yield* probe(`${base}/v1/traces`, injected);
        if (listener === 4318) {
          expect(read, "nothing listens on the collector's old port").toMatch(/^refused /);
          expect(counters).toMatch(/^refused /);
          expect(written).toMatch(/^refused /);
        }
      }
      const laterTrace = randomBytes(16).toString("hex");
      expect((yield* request("/api/viewer", undefined, cookie, laterTrace)).status).toBe(200);
      yield* spans(laterTrace);
      expect(
        (yield* run([
          "exec",
          id,
          "sh",
          "-c",
          'executor-host telemetry "$1" 2>&1 >/dev/null || true',
          "sh",
          `/api/traces/${injectedTrace}`,
        ])).trim(),
        "no app wrote spans into the collector",
      ).toBe("Executor: the telemetry collector answered 404");
      const collectorSockets = yield* run([
        "run",
        "--rm",
        "--pid",
        `container:${id}`,
        "--user",
        "1000",
        "node:24-bookworm-slim",
        "node",
        "-e",
        `const fs = require("node:fs");
const pid = fs.readdirSync("/proc").filter((p) => /^\\d+$/.test(p)).find((p) => {
  try { return fs.readFileSync("/proc/" + p + "/cmdline", "utf8").split("\\0")[0] === "/app/" + ["executor", "collector"].join("-"); } catch { return false; }
});
const inodes = fs.readdirSync("/proc/" + pid + "/fd").flatMap((fd) => {
  try { return [fs.readlinkSync("/proc/" + pid + "/fd/" + fd)]; } catch { return []; }
}).flatMap((target) => /^socket:\\[(\\d+)\\]$/.exec(target)?.slice(1) ?? []);
const table = (name) => fs.readFileSync("/proc/" + pid + "/net/" + name, "utf8").split("\\n").slice(1).map((line) => line.trim().split(/\\s+/));
process.stdout.write(JSON.stringify({
  tcp: [...table("tcp"), ...table("tcp6")].filter((fields) => inodes.includes(fields[9])).map((fields) => fields[1]),
  unix: table("unix").filter((fields) => inodes.includes(fields[6])).map((fields) => fields[7] ?? ""),
}));`,
      ]).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                tcp: Schema.Array(Schema.String),
                unix: Schema.Array(Schema.String),
              }),
            ),
          ),
        ),
      );
      expect(collectorSockets.tcp, "the collector has no TCP socket").toEqual([]);
      expect(collectorSockets.unix).toContainEqual(
        expect.stringMatching(/^\/tmp\/executor-host-\d+\/collector\.sock$/),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("released images that share a temporary directory keep separate collectors", () =>
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
      const name = `executor-shared-tmp-${randomBytes(6).toString("hex")}`;
      const volume = (suffix: string) =>
        Effect.acquireRelease(run(["volume", "create", `${name}-${suffix}`]), () =>
          run(["volume", "rm", "--force", `${name}-${suffix}`]).pipe(Effect.orDie),
        ).pipe(Effect.as(`${name}-${suffix}`));
      const temporary = yield* volume("tmp");
      yield* run([
        "run",
        "--rm",
        "--user",
        "0",
        "--entrypoint",
        "sh",
        "--volume",
        `${temporary}:/shared-tmp`,
        image,
        "-c",
        "chmod 1777 /shared-tmp",
      ]);
      const start = Effect.fn("start instance")(function* (suffix: string) {
        const data = yield* volume(suffix);
        const id = `${name}-${suffix}`;
        const environment: Record<string, string> = {
          DO_NOT_TRACK: "1",
          PORT: "8080",
          BETTER_AUTH_URL: "http://localhost:8080",
          BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
          EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
          TMPDIR: "/shared-tmp",
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
              "127.0.0.1::8080",
              "--volume",
              `${temporary}:/shared-tmp`,
              "--volume",
              `${data}:/app/data`,
              ...Object.keys(environment).flatMap((key) => ["--env", key]),
              image,
            ],
            environment,
          ),
          () => run(["rm", "--force", "--volumes", id]).pipe(Effect.orDie),
        );
        yield* Effect.addFinalizer((exit) =>
          Exit.isFailure(exit)
            ? run(["logs", id]).pipe(Effect.flatMap(Console.error), Effect.ignore)
            : Effect.void,
        );
        return id;
      });
      const succeeds = (args: readonly string[]) =>
        processes.exitCode(ChildProcess.make("docker", args)).pipe(
          Effect.filterOrFail(
            (code) => code === 0,
            () => `docker ${args.join(" ")} failed`,
          ),
        );
      const ready = (id: string) =>
        Effect.gen(function* () {
          yield* succeeds(["exec", id, "executor-host", "health"]);
          yield* succeeds(["exec", id, "executor-host", "telemetry", "/api/health"]);
        }).pipe(Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240 }));
      const traced = Effect.fn("traced request")(function* (id: string) {
        const published = (yield* run(["port", id, "8080/tcp"])).trim().split("\n")[0]!;
        const trace = randomBytes(16).toString("hex");
        yield* driver("traced request", () =>
          fetch(`http://${published}/api/viewer`, {
            headers: { traceparent: `00-${trace}-1234567890abcdef-01` },
          }).then((response) => response.arrayBuffer()),
        );
        return trace;
      });
      const stored = (id: string, trace: string, problem: string) =>
        run(["exec", id, "executor-host", "telemetry", `/api/traces/${trace}/spans`]).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  data: Schema.Array(
                    Schema.Struct({ span: Schema.Struct({ serviceName: Schema.String }) }),
                  ),
                }),
              ),
            ),
          ),
          Effect.flatMap((spans) =>
            spans.data.some(({ span }) => span.serviceName === "executor-selfhost")
              ? Effect.void
              : Effect.fail(`${id}: ${problem}`),
          ),
        );
      const delivered = (id: string, trace: string) =>
        stored(id, trace, "a new trace did not reach this instance's collector").pipe(
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
        );
      const keeps = Effect.fn("instance keeps its collector")(function* (
        id: string,
        traces: readonly string[],
        when: string,
      ) {
        yield* ready(id);
        for (const trace of traces) yield* stored(id, trace, `lost a stored trace ${when}`);
        const trace = yield* traced(id);
        yield* delivered(id, trace);
        return [...traces, trace];
      });
      const first = yield* start("a");
      let firstTraces = yield* keeps(first, [], "on start");
      const second = yield* start("b");
      let secondTraces = yield* keeps(second, [], "on start");
      firstTraces = yield* keeps(first, firstTraces, "after b started");
      yield* run(["stop", second]);
      firstTraces = yield* keeps(first, firstTraces, "after b stopped");
      yield* run(["start", second]);
      secondTraces = yield* keeps(second, secondTraces, "after b restarted");
      firstTraces = yield* keeps(first, firstTraces, "after b restarted");
      yield* run(["stop", first]);
      secondTraces = yield* keeps(second, secondTraces, "after a stopped");
      yield* run(["start", first]);
      yield* keeps(first, firstTraces, "after a restarted");
      yield* keeps(second, secondTraces, "after a restarted");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

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
      const network = yield* releaseNetwork("tailnet");
      const address = `${network.subnet}.10`;
      const containerPort = 8080;
      const hostname = "nexus.example.ts.net";
      const origin = `http://${hostname}:${containerPort}`;
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
      const environment: Record<string, string> = {
        DO_NOT_TRACK: "1",
        PORT: String(containerPort),
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
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
            network.name,
            "--ip",
            address,
            "--add-host",
            `${hostname}:${address}`,
            "--add-host",
            `${disguised}:${address}`,
            "--publish",
            `127.0.0.1:${port}:${containerPort}`,
            ...Object.keys(environment).flatMap((name) => ["--env", name]),
            ...registry.docker,
            image,
          ],
          environment,
        ),
        () => run(["rm", "--force", "--volumes", id]).pipe(Effect.orDie),
      );
      yield* Effect.addFinalizer((exit) =>
        Exit.isFailure(exit)
          ? run(["logs", id]).pipe(Effect.flatMap(Console.error), Effect.ignore)
          : Effect.void,
      );
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
      const request = (
        route: string,
        data?: unknown,
        cookie?: string,
        client: Record<string, string> = currentClient,
      ) =>
        driver("tailnet image HTTP request", () =>
          hostFetch(`${origin}${route}`, {
            method: data === undefined ? "GET" : "POST",
            headers: {
              ...client,
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
const listings = [
  { name: "@fixture/example", commit: "${"a".repeat(40)}", description: "A shared example", publishedAt: "2026-01-01T00:00:00.000Z" },
  { name: "@scoped.executor.community/notes", commit: "${"b".repeat(40)}", description: "Notes in a publishing scope", publishedAt: "2026-01-02T00:00:00.000Z" },
];
http.createServer((request, response) => {
  const url = new URL(request.url, "http://registry.invalid");
  if (url.pathname === "/stats") return response.end(JSON.stringify(paths));
  paths.push(url.pathname + url.search);
  const name = url.searchParams.get("name");
  if (name === "@fixture/moved") return response.writeHead(302, { location: "/elsewhere" }).end();
  if (name === "@fixture/down") return response.writeHead(503, { "content-type": "text/plain" }).end("unavailable");
  if (name === "@fixture/garbled") return response.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
  const found = name === null ? listings : listings.filter((listing) => listing.name === name);
  if (found.length === 0)
    return response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ _tag: "RegistryError", reason: "not-found" }));
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(found));
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
      const catalog = (name?: string, client?: Record<string, string>) =>
        request(
          `${prefix}/app-publications${name === undefined ? "" : `?name=${encodeURIComponent(name)}`}`,
          undefined,
          cookie,
          client,
        ).pipe(
          Effect.flatMap((response) =>
            driver("catalog response", () => response.json()).pipe(
              Effect.map((body: unknown) => ({ status: response.status, body })),
            ),
          ),
        );
      const example = {
        name: "@fixture/example",
        commit: "a".repeat(40),
        description: "A shared example",
        publishedAt: "2026-01-01T00:00:00.000Z",
      };
      const notes = {
        name: "@scoped.executor.community/notes",
        commit: "b".repeat(40),
        description: "Notes in a publishing scope",
        publishedAt: "2026-01-02T00:00:00.000Z",
      };
      expect(yield* catalog()).toEqual({ status: 200, body: [example, notes] });
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
      const released = {};
      const lookups = (...names: ReadonlyArray<string>) =>
        names.map((name) => `/api/registry/apps?name=${encodeURIComponent(name)}`).toSorted();
      const lookupsFor = (name: string, client: Record<string, string> = released) =>
        Effect.gen(function* () {
          const before = (yield* registryPaths).length;
          const answer = yield* catalog(name, client);
          return { answer, lookups: (yield* registryPaths).slice(before).toSorted() };
        });
      expect(yield* catalog(undefined, released), "a released client's catalog").toEqual({
        status: 200,
        body: [example, { ...notes, name: "@scoped/notes" }],
      });
      expect(yield* lookupsFor("@fixture/example"), "a released client's dotless name").toEqual({
        answer: { status: 200, body: [example] },
        lookups: lookups("@fixture/example", "@fixture.executor.community/example"),
      });
      expect(yield* lookupsFor("@scoped/notes"), "a released client's slug name").toEqual({
        answer: { status: 200, body: [{ ...notes, name: "@scoped/notes" }] },
        lookups: lookups("@scoped/notes", "@scoped.executor.community/notes"),
      });
      expect(yield* lookupsFor("@fixture/missing"), "a released client's missing name").toEqual({
        answer: { status: 400, body: { _tag: "RegistryError", ...failures["@fixture/missing"] } },
        lookups: lookups("@fixture/missing", "@fixture.executor.community/missing"),
      });
      expect(yield* lookupsFor("@scoped/notes", currentClient), "a current client").toEqual({
        answer: { status: 400, body: { _tag: "RegistryError", ...failures["@fixture/missing"] } },
        lookups: lookups("@scoped/notes"),
      });
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
export default defineApp({}, async () => ({
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
      yield* Effect.gen(function* () {
        const inventory = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            apps: Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String })),
            links: Schema.Array(Schema.Struct({ app: Schema.String, account: Schema.String })),
          }),
        )(
          yield* request(`${prefix}/inventory`, undefined, cookie).pipe(
            Effect.flatMap((response) => driver("inventory", () => response.json())),
          ),
        );
        const executor = inventory.apps.find((item) => item.slug === "executor");
        if (executor === undefined) return yield* Effect.fail("Executor app pending");
        if (!inventory.links.some((link) => link.app === executor.id))
          return yield* Effect.fail("Executor key pending");
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
        `return await tools.executor.appManagement.source(${JSON.stringify({ path: { organization: organization.id, app: app.id } })})`,
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
          `return await tools[${JSON.stringify(app.slug)}].probe(${JSON.stringify({ url })})`,
        );
      const refused = yield* probe(`http://${address}:${containerPort}/health`);
      expect(refused.ok).toBe(true);
      expect(refused.value, "private app fetch stays off by default").toMatch(
        /^refused:Executor refused a request to 100\.64\.[\d.]+:\d+: apps on this instance can reach only public addresses/,
      );
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

type Probe = Effect.Effect<{ readonly isolate: string; readonly calls: number }, unknown>;

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
        const start = (limit: string | undefined) =>
          Effect.gen(function* () {
            const id = `executor-app-workers-${randomBytes(6).toString("hex")}`;
            const port = yield* freePort;
            const origin = `http://localhost:${port}`;
            const environment: Record<string, string> = {
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
              () => run(["rm", "--force", "--volumes", id]).pipe(Effect.orDie),
            );
            return { id, origin, address: `http://127.0.0.1:${port}` };
          });

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
            const executorSources = yield* Effect.gen(function* () {
              const { apps: installed } = yield* request(
                `${prefix}/inventory`,
                undefined,
                cookie,
              ).pipe(
                Effect.flatMap((response) =>
                  json(
                    Schema.Struct({
                      apps: Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String })),
                    }),
                    response,
                  ),
                ),
              );
              const executorApp = installed.find((app) => app.slug === "executor");
              if (executorApp === undefined)
                return yield* Effect.fail(new Error("The built-in Executor app is not installed"));
              const sources = yield* request(
                `${prefix}/apps/${executorApp.id}/webhook-sources`,
                undefined,
                cookie,
              ).pipe(
                Effect.flatMap((response) =>
                  json(Schema.Array(Schema.Struct({ status: Schema.String })), response),
                ),
              );
              return sources.length === 0 || sources.some((source) => source.status === "pending")
                ? yield* Effect.fail(new Error("Executor app setup has not finished"))
                : sources;
            }).pipe(Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 150 }));
            for (const source of executorSources)
              expect(source.status, "the built-in Executor app is set up").toBe("ready");
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
export default defineApp({}, async () => ({
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
              probes.push(
                request(
                  `${prefix}/apps/${app.id}/tools/call`,
                  { tool: "probe", input: {} },
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

        yield* Effect.scoped(
          Effect.gen(function* () {
            const probes = yield* serve(undefined, 65);
            const first: Array<{ isolate: string; calls: number }> = [];
            for (const probe of probes) first.push(yield* probe);
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

const Workspace = Schema.Struct({ revision: Schema.Struct({ commit: Schema.String }) });

type RawResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly body: Buffer;
};

const varies = (response: RawResponse) =>
  [response.headers.vary ?? []]
    .flat()
    .flatMap((value) => value.split(","))
    .map((field) => field.trim().toLowerCase());

it.live(
  "released image compresses dashboard files and API JSON and keeps event streams live",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const image = yield* Config.String("EXECUTOR_E2E_DOCKER_IMAGE");
        const registry = yield* containerNpmRegistry;
        const run = (args: readonly string[], env: Record<string, string> = {}) =>
          processes.string(ChildProcess.make("docker", args, { env, extendEnv: true }));
        const id = `executor-compression-${randomBytes(6).toString("hex")}`;
        const port = yield* driver(
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
        const origin = `http://localhost:${port}`;
        const address = `http://127.0.0.1:${port}`;
        const environment: Record<string, string> = {
          DO_NOT_TRACK: "1",
          PORT: "8080",
          BETTER_AUTH_URL: origin,
          BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
          EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
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
              `127.0.0.1:${port}:8080`,
              ...Object.keys(environment).flatMap((name) => ["--env", name]),
              ...registry.docker,
              image,
            ],
            environment,
          ),
          () => run(["rm", "--force", "--volumes", id]).pipe(Effect.orDie),
        );
        yield* Effect.addFinalizer((exit) =>
          Exit.isFailure(exit)
            ? run(["logs", id]).pipe(Effect.flatMap(Console.error), Effect.ignore)
            : Effect.void,
        );
        let cookie = "";
        const request = (route: string, data?: unknown) =>
          driver(`${data === undefined ? "GET" : "POST"} ${route}`, (signal) =>
            fetch(`${address}${route}`, {
              method: data === undefined ? "GET" : "POST",
              signal,
              headers: {
                origin,
                "content-type": "application/json",
                ...(cookie === "" ? {} : { cookie }),
              },
              ...(data === undefined ? {} : { body: JSON.stringify(data) }),
            }),
          );
        const json = <S extends Schema.Top>(schema: S, route: string, data?: unknown) =>
          request(route, data).pipe(
            Effect.flatMap((response) =>
              driver(`read ${route}`, () => response.text()).pipe(
                Effect.flatMap((text) =>
                  response.status === 200
                    ? Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text)
                    : Effect.fail(new Error(`${route}: HTTP ${response.status} ${text}`)),
                ),
              ),
            ),
          );
        const raw = (route: string, acceptEncoding: string | undefined) =>
          driver(
            `GET ${route} accepting ${acceptEncoding ?? "no encoding"}`,
            () =>
              new Promise<RawResponse>((resolve, reject) => {
                const outgoing = httpRequest(
                  `${address}${route}`,
                  {
                    headers: {
                      origin,
                      ...(cookie === "" ? {} : { cookie }),
                      ...(acceptEncoding === undefined
                        ? {}
                        : { "accept-encoding": acceptEncoding }),
                    },
                  },
                  (response) => {
                    const chunks: Array<Buffer> = [];
                    response.on("data", (chunk: Buffer) => chunks.push(chunk));
                    response.once("error", reject);
                    response.once("end", () =>
                      resolve({
                        status: response.statusCode ?? 0,
                        headers: response.headers,
                        body: Buffer.concat(chunks),
                      }),
                    );
                  },
                );
                outgoing.once("error", reject);
                outgoing.end();
              }),
          );
        const decoded = (route: string, acceptEncoding: string) =>
          driver(`read ${route} accepting ${acceptEncoding}`, (signal) =>
            fetch(`${address}${route}`, {
              signal,
              headers: {
                origin,
                "accept-encoding": acceptEncoding,
                ...(cookie === "" ? {} : { cookie }),
              },
            }).then((response) =>
              response.arrayBuffer().then((body) => ({
                encoding: response.headers.get("content-encoding"),
                body: Buffer.from(body),
              })),
            ),
          );
        yield* request("/health").pipe(
          Effect.flatMap((response) =>
            response.status === 200 ? Effect.void : Effect.fail("not ready"),
          ),
          Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240 }),
        );

        const browserEncodings = "gzip, deflate, br, zstd";
        const login = yield* raw("/login", browserEncodings);
        expect(login.status).toBe(200);
        expect(login.headers["content-encoding"], "the sign-in page is compressed").toBe("br");
        expect(varies(login)).toContain("accept-encoding");
        const html = (yield* decoded("/login", browserEncodings)).body.toString("utf8");
        expect(html).toMatch(/^<!DOCTYPE html>/);
        const script = /\/assets\/[\w-]+\.js/.exec(html)?.[0];
        expect(script, "the sign-in page loads a hashed script").toBeDefined();
        const identity = yield* raw(script!, undefined);
        expect(identity.status).toBe(200);
        expect(identity.headers["content-encoding"]).toBeUndefined();
        expect(varies(identity), "caches keep encoded and plain copies apart").toContain(
          "accept-encoding",
        );
        for (const [accepted, encoding] of [
          [browserEncodings, "br"],
          ["gzip", "gzip"],
        ] as const) {
          const encoded = yield* raw(script!, accepted);
          expect(encoded.headers["content-encoding"], `the script is sent as ${encoding}`).toBe(
            encoding,
          );
          expect(encoded.headers["content-length"]).toBeUndefined();
          expect(encoded.headers["cache-control"]).toBe(identity.headers["cache-control"]);
          expect(encoded.body.length).toBeLessThan(identity.body.length / 2);
          const decoding = yield* decoded(script!, accepted);
          expect(decoding.encoding).toBe(encoding);
          expect(decoding.body.equals(identity.body), `${encoding} decodes exactly`).toBe(true);
        }
        expect((yield* raw("/favicon.png", browserEncodings)).headers["content-encoding"]).toBe(
          undefined,
        );
        expect((yield* raw("/health", browserEncodings)).headers["content-encoding"]).toBe(
          undefined,
        );

        const setup = yield* request("/api/auth/self-host/setup", {
          name: "Compression Owner",
          email: "compression@example.test",
          password: "Synthetic-compression-password-123!",
          organizationName: "Compression lab",
        });
        expect(setup.status).toBe(200);
        cookie = setup.headers
          .getSetCookie()
          .map((part) => part.split(";")[0])
          .join("; ");
        const [organization] = yield* json(
          Schema.NonEmptyArray(Schema.Struct({ id: Schema.String, slug: Schema.String })),
          "/api/auth/organization/list",
        );
        const prefix = `/api/organizations/${organization.id}`;

        const openapi = yield* raw("/openapi.json", browserEncodings);
        expect(openapi.headers["content-encoding"], "API JSON is compressed").toBe("br");
        const plainOpenapi = yield* raw("/openapi.json", undefined);
        expect(openapi.body.length).toBeLessThan(plainOpenapi.body.length / 4);
        const decodedOpenapi = yield* decoded("/openapi.json", browserEncodings);
        expect(decodedOpenapi.encoding).toBe("br");
        expect(JSON.parse(decodedOpenapi.body.toString("utf8"))).toEqual(
          JSON.parse(plainOpenapi.body.toString("utf8")),
        );

        const browser = yield* Effect.acquireRelease(
          driver("launch the compression browser", () => chromium.launch()),
          (browser) =>
            driver("close the compression browser", () => browser.close()).pipe(Effect.orDie),
        );
        const page = yield* driver("new browser session", () => browser.newPage());
        page.setDefaultTimeout(20_000);
        const reportStall = stalledPageReport(page);
        const scripts: Array<{ url: string; encoding: string | undefined }> = [];
        page.on("response", (response) => {
          if (new URL(response.url()).pathname.endsWith(".js"))
            scripts.push({ url: response.url(), encoding: response.headers()["content-encoding"] });
        });
        yield* driver("open the dashboard sign-in", () => page.goto(`${origin}/login`));
        yield* driver("enter the owner's email", () =>
          page.getByLabel("Email", { exact: true }).fill("compression@example.test"),
        );
        yield* driver("enter the owner's password", () =>
          page.getByLabel("Password", { exact: true }).fill("Synthetic-compression-password-123!"),
        );
        yield* driver("sign in", () =>
          page.getByRole("button", { name: "Sign in", exact: true }).click(),
        );
        yield* reportStall(
          driver("the apps page document loads", () =>
            page.waitForURL(
              (url) => url.origin === origin && url.pathname === `/org/${organization.slug}/apps`,
            ),
          ),
        );
        yield* reportStall(
          driver("the apps page renders", () =>
            page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
          ),
        );
        expect(scripts.length).toBeGreaterThan(0);
        expect(
          scripts.filter((loaded) => loaded.encoding !== "br"),
          "every dashboard script arrives compressed",
        ).toEqual([]);

        const files = (heading: string) => [
          {
            path: "index.ts",
            content: `import { defineApp, query, object, router } from "apps";
export default defineApp({}, async () => ({ tools: router({ ping: query({ input: object({}) }, async () => "pong") }) }));`,
          },
          appsManifest,
          {
            path: "ui/index.html",
            content: `<!doctype html><html><head><title>Stream check</title></head><body><h1>${heading}</h1></body></html>`,
          },
        ];
        const app = yield* json(Schema.Struct({ id: Schema.String }), `${prefix}/apps/deploy`, {
          name: "Stream check",
          files: files("First deployment"),
        });
        const path = `${prefix}/apps/${app.id}`;
        const ui = yield* json(
          Schema.Struct({ status: Schema.Literal("ready"), url: Schema.String }),
          `${path}/ui`,
        ).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }));
        const [stream] = yield* driver("open the app page and its version stream", () =>
          Promise.all([
            page.waitForResponse(
              (response) => new URL(response.url()).pathname === "/_executor/version",
            ),
            page.goto(ui.url),
          ]),
        );
        expect(stream.status()).toBe(200);
        expect(stream.headers()["content-type"]).toMatch(/^text\/event-stream/);
        expect(stream.headers()["content-encoding"], "event streams are not encoded").toBe(
          undefined,
        );
        yield* driver("the first version renders", () =>
          page.getByRole("heading", { name: "First deployment" }).waitFor(),
        );
        const workspace = yield* json(Workspace, `${path}/workspace`);
        const saved = yield* json(Workspace, `${path}/commits`, {
          expected: workspace.revision.commit,
          files: files("Second deployment"),
          message: "Change the heading",
        });
        expect((yield* request(`${path}/deploy`, { commit: saved.revision.commit })).status).toBe(
          200,
        );
        yield* driver("the open page reloads into the new version", () =>
          page.getByRole("heading", { name: "Second deployment" }).waitFor(),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  300_000,
);
