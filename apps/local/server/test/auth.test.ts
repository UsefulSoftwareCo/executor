/** Real loopback auth boundaries and deterministic expiry; all keys are synthetic. */
import assert from "node:assert/strict";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  LocalAuthApi,
  DesktopBootstrap,
  ServerReady,
  SessionHash,
  PairingLink,
} from "../src/contracts/auth.ts";
import { AppId, ExecutorApi, OwnerId, SourceFiles } from "@executor-js/sdk";
import { appOrigin } from "../src/contracts/app-ui.ts";
import { pgliteLayer } from "fumadb-effect/pglite";
import { fumadb } from "fumadb-effect";
import { sqlAdapter } from "fumadb-effect/sql";
import { column, idColumn, schema, table } from "fumadb-effect/schema";
import { ServerConfig } from "../src/contracts/config.ts";
import { DashboardApi, McpInstallation } from "../src/contracts/dashboard.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeLocalAuth, sessionCookie } from "../src/implementation/auth.ts";
import { startLocalServer } from "../src/node.ts";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

// Scan persisted relation/WAL files after close: raw bearer credentials must never reach disk.
const databaseBytes = (
  directory: string,
): Effect.Effect<string, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(directory);
    const parts: string[] = [];
    for (const entry of entries) {
      const location = path.join(directory, entry);
      const info = yield* fs.stat(location);
      parts.push(
        info.type === "Directory"
          ? yield* databaseBytes(location)
          : new TextDecoder().decode(yield* fs.readFile(location)),
      );
    }
    return parts.join("");
  });

const apiKey = "synthetic-local-auth-bearer-0000000000";
const encryptionKey = "bc".repeat(32);
const settings = (directory: string, port = 0) =>
  Schema.decodeUnknownSync(ServerConfig)({ directory, port, apiKey, encryptionKey });

const client = (url: string, headers: Record<string, string> = {}) =>
  Effect.runPromise(
    HttpApiClient.make(LocalAuthApi, {
      baseUrl: url,
      transformClient: (http) =>
        http.pipe(HttpClient.mapRequest(HttpClientRequest.setHeaders(headers))),
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

const withDirectory = (
  run: (directory: string) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-auth-" });
        yield* run(directory);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

test("one-use grants and sessions expire, and replay cannot create another session", async () => {
  await withDirectory((directory) =>
    Effect.scoped(
      Effect.gen(function* () {
        const auth = yield* makeLocalAuth(globalThis.crypto, directory);
        const first = yield* auth.issue();
        const session = yield* auth.exchange(first.token);
        assert.equal(yield* auth.valid(Redacted.value(session)), true);
        assert.equal((yield* Effect.flip(auth.exchange(first.token)))._tag, "PairingRejected");
        const expired = yield* auth.issue();
        yield* TestClock.adjust("5 minutes");
        assert.equal((yield* Effect.flip(auth.exchange(expired.token)))._tag, "PairingRejected");
        yield* TestClock.adjust("7 days");
        assert.equal(yield* auth.valid(Redacted.value(session)), false);
        const concurrent = yield* auth.issue();
        const results = yield* Effect.all(
          [
            auth.exchange(concurrent.token).pipe(Effect.result),
            auth.exchange(concurrent.token).pipe(Effect.result),
          ],
          { concurrency: 2 },
        );
        assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      }),
    ).pipe(Effect.provide(TestClock.layer()), Effect.provide(NodeServices.layer)),
  );
});

test(
  "browser cookie reads survive refresh and enforce Origin, Host, replay, logout and bearer separation",
  { timeout: 15_000 },
  async () => {
    await withDirectory((directory) =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startLocalServer(settings(directory));
          yield* Effect.tryPromise({
            try: async () => {
              const anonymous = await client(server.url);
              assert.deepEqual(await Effect.runPromise(anonymous.auth.session()), {
                authenticated: false,
              });
              const pairing = await serverLink(server);
              const token = new URL(pairing).hash.slice("#pair=".length);
              const browser = await client(server.url, { origin: server.url });
              const [result, exchange] = await Effect.runPromise(
                browser.auth.exchange({
                  payload: { token: Redacted.make(token) },
                  responseMode: "decoded-and-response",
                }),
              );
              assert.deepEqual(result, { authenticated: true });
              const cookieHeader = exchange.headers["set-cookie"];
              assert.ok(cookieHeader);
              assert.match(cookieHeader, /HttpOnly/i);
              assert.match(cookieHeader, /SameSite=Strict/i);
              assert.match(cookieHeader, /Max-Age=604800/);
              const cookie = cookieHeader.split(";")[0];
              assert.ok(cookie);
              assert.match(
                cookie,
                new RegExp(`^${sessionCookie(Number(new URL(server.url).port))}=`),
              );
              const authenticated = await client(server.url, { cookie, origin: server.url });
              for (let count = 0; count < 2; count++) {
                assert.deepEqual(await Effect.runPromise(authenticated.auth.session()), {
                  authenticated: true,
                });
                const inventory: Response = await fetch(`${server.url}/dashboard/api/overview`, {
                  headers: { cookie, origin: server.url },
                });
                assert.equal(inventory.status, 200);
                assert.ok(!(await inventory.text()).includes(apiKey));
              }
              const installUrl = `${server.url}/dashboard/api/mcp-installation`;
              const anonymousInstall = await fetch(installUrl);
              assert.equal(anonymousInstall.status, 401);
              await anonymousInstall.body?.cancel();
              const foreignInstall = await fetch(installUrl, {
                headers: { cookie, origin: "https://example.com" },
              });
              assert.equal(foreignInstall.status, 403);
              await foreignInstall.body?.cancel();
              const installationResponse = await fetch(installUrl, {
                headers: { cookie, origin: server.url },
              });
              assert.equal(installationResponse.status, 200);
              assert.equal(installationResponse.headers.get("cache-control"), "no-store");
              const installationBody = await installationResponse.json();
              assert.ok(!JSON.stringify(installationBody).includes(apiKey));
              assert.ok(!Object.hasOwn(installationBody, "apiKey"));
              const installation = Schema.decodeUnknownSync(McpInstallation)(installationBody);
              assert.equal(installation.endpoint, `${server.url}/mcp`);
              const agent = new Client({ name: "install-instructions-test", version: "1.0.0" });
              const transport = new StreamableHTTPClientTransport(new URL(installation.endpoint), {
                requestInit: {
                  headers: { Authorization: `Bearer ${apiKey}` },
                },
              });
              // The SDK's optional sessionId getter conflicts with its own Transport type.
              const wire: Omit<StreamableHTTPClientTransport, "sessionId"> = transport;
              try {
                await agent.connect(wire);
                assert.deepEqual((await agent.listTools()).tools.map((tool) => tool.name).sort(), [
                  "execute",
                  "resume",
                  "skills",
                ]);
              } finally {
                await agent.close();
              }
              assert.equal(
                (
                  await Effect.runPromise(
                    Effect.flip(
                      browser.auth.exchange({ payload: { token: Redacted.make(token) } }),
                    ),
                  )
                )._tag,
                "PairingRejected",
              );
              const foreign = await client(server.url, { cookie, origin: "https://example.com" });
              assert.equal(
                (await Effect.runPromise(Effect.flip(foreign.auth.session())))._tag,
                "AuthForbidden",
              );
              const rebound = await new Promise<number | undefined>((resolve, reject) => {
                const probe = request(
                  `${server.url}/auth/session`,
                  { headers: { cookie, host: "attacker.example" } },
                  (response) => {
                    response.resume();
                    response.on("end", () => resolve(response.statusCode));
                  },
                );
                probe.on("error", reject);
                probe.end();
              });
              assert.equal(rebound, 403);
              const programmatic = await fetch(`${server.url}/v1/apps`, { headers: { cookie } });
              assert.equal(programmatic.status, 401);
              await programmatic.body?.cancel();
              const publicIssue = await anonymous.auth.pair().pipe(Effect.flip, Effect.runPromise);
              assert.equal(publicIssue._tag, "PairingUnauthorized");
              const bearer = await client(server.url, { authorization: `Bearer ${apiKey}` });
              assert.ok(
                Redacted.value((await Effect.runPromise(bearer.auth.pair())).url).includes(
                  "#pair=",
                ),
              );
              const browserBearer = await client(server.url, {
                authorization: `Bearer ${apiKey}`,
                origin: server.url,
              });
              assert.equal(
                (await Effect.runPromise(Effect.flip(browserBearer.auth.pair())))._tag,
                "AuthForbidden",
              );
              const browserPair = await fetch(`${server.url}/auth/pair`, {
                method: "POST",
                headers: { cookie, origin: server.url },
              });
              assert.equal(browserPair.status, 200, "A paired dashboard can pair another browser");
              const issued = Schema.decodeUnknownSync(Schema.toCodecJson(PairingLink))(
                await browserPair.json(),
              );
              const browserToken = new URL(Redacted.value(issued.url)).hash.slice("#pair=".length);
              const second = await fetch(`${server.url}/auth/exchange`, {
                method: "POST",
                headers: { origin: server.url, "content-type": "application/json" },
                body: JSON.stringify({ token: browserToken }),
              });
              assert.equal(second.status, 200);
              const secondCookie = second.headers.get("set-cookie")?.split(";")[0];
              assert.ok(secondCookie);
              assert.notEqual(secondCookie, cookie);
              const secondBrowser = await client(server.url, {
                cookie: secondCookie,
                origin: server.url,
              });
              assert.deepEqual(await Effect.runPromise(secondBrowser.auth.session()), {
                authenticated: true,
              });
              const noOrigin = await fetch(`${server.url}/auth/pair`, {
                method: "POST",
                headers: { cookie },
              });
              assert.equal(noOrigin.status, 401);
              await noOrigin.body?.cancel();
              const foreignPair = await fetch(`${server.url}/auth/pair`, {
                method: "POST",
                headers: { cookie, origin: "https://example.com" },
              });
              assert.equal(foreignPair.status, 403);
              await foreignPair.body?.cancel();
              await Effect.runPromise(authenticated.auth.logout());
              assert.deepEqual(await Effect.runPromise(authenticated.auth.session()), {
                authenticated: false,
              });
              const rejectedRead = await fetch(`${server.url}/dashboard/api/overview`, {
                headers: { cookie },
              });
              assert.equal(rejectedRead.status, 401);
              await rejectedRead.body?.cancel();
              const revokedInstall = await fetch(installUrl, { headers: { cookie } });
              assert.equal(revokedInstall.status, 401);
              await revokedInstall.body?.cancel();
            },
            catch: (error) => error,
          });
        }),
      ),
    );
  },
);

const sdkClient = (url: string, apiKey: Redacted.Redacted<string>) =>
  HttpApiClient.make(ExecutorApi, {
    baseUrl: url,
    transformClient: (client) =>
      client.pipe(
        HttpClient.mapRequest(
          HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(apiKey)}`),
        ),
      ),
  }).pipe(Effect.provide(FetchHttpClient.layer));

const serverLink = (server: Effect.Success<ReturnType<typeof startLocalServer>>) =>
  Effect.runPromise(server.issuePairingLink).then((link) => Redacted.value(link.url));

test("the local dashboard creates profiles for the bundled Executor app", async () => {
  await withDirectory((directory) =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = settings(directory);
        const server = yield* startLocalServer(config);
        const sdk = yield* sdkClient(server.url, config.apiKey);
        const managed = (yield* sdk.apps.list({
          query: { owner: OwnerId.make("executor-local") },
        }))[0];
        assert.ok(managed);
        const dashboard = yield* HttpApiClient.make(DashboardApi, {
          baseUrl: server.url,
          transformClient: (http) =>
            http.pipe(
              HttpClient.mapRequest(
                HttpClientRequest.setHeader(
                  "authorization",
                  `Bearer ${Redacted.value(config.apiKey)}`,
                ),
              ),
            ),
        }).pipe(Effect.provide(FetchHttpClient.layer));
        const profile = yield* dashboard.profiles.create({
          params: { app: managed.id },
          payload: { idempotencyKey: "additional-profile", name: "Additional", accounts: {} },
        });
        assert.equal(profile.owner, managed.owner);
        assert.equal(profile.subject, "local");
        assert.equal(profile.app, managed.id);
        assert.deepEqual(profile.accounts, {});
        assert.deepEqual(
          yield* dashboard.profiles.get({ params: { app: managed.id, profile: profile.id } }),
          profile,
        );
      }),
    ),
  );
});

test(
  "a browser cookie survives server restart and logout remains revoked after another restart",
  { timeout: 15_000 },
  async () => {
    await withDirectory((directory) =>
      Effect.gen(function* () {
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* startLocalServer(settings(directory));
            const link = yield* server.issuePairingLink;
            const browser = yield* Effect.promise(() => client(server.url, { origin: server.url }));
            const [, response] = yield* browser.auth.exchange({
              payload: {
                token: Redacted.make(new URL(Redacted.value(link.url)).hash.slice("#pair=".length)),
              },
              responseMode: "decoded-and-response",
            });
            const cookie = response.headers["set-cookie"]?.split(";")[0];
            assert.ok(cookie);
            const unused = yield* server.issuePairingLink;
            const sdk = yield* sdkClient(server.url, settings(directory).apiKey);
            const owner = OwnerId.make("executor-local");
            const managed = (yield* sdk.apps.list({ query: { owner } }))[0];
            assert.ok(managed);
            const source = yield* sdk.apps.workspace({
              params: { app: managed.id },
              query: { owner },
            });
            const deployed = yield* sdk.apps.deploy({
              payload: {
                owner,
                app: managed.id,
                files: SourceFiles.make([
                  ...source.files,
                  { path: "old-bundled-guide.md", content: "Older bundled management source" },
                ]),
              },
            });
            const profiles = yield* sdk.appProfiles.list({
              params: { app: managed.id },
              query: {},
            });
            return {
              url: server.url,
              cookie,
              unused,
              managed,
              profiles,
              deployment: deployed.deployment.id,
            };
          }),
        );
        const port = Number(new URL(first.url).port);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* startLocalServer(settings(directory, port));
            const sdk = yield* sdkClient(server.url, settings(directory).apiKey);
            const managed = yield* sdk.apps.get({ params: { app: first.managed.id }, query: {} });
            assert.notEqual(managed.activeDeployment, first.deployment);
            const profiles = yield* sdk.appProfiles.list({
              params: { app: managed.id },
              query: {},
            });
            assert.deepEqual(
              profiles.map((profile) => ({ id: profile.id, accounts: profile.accounts })),
              first.profiles.map((profile) => ({ id: profile.id, accounts: profile.accounts })),
            );
            const source = yield* sdk.apps.workspace({ params: { app: managed.id }, query: {} });
            assert.equal(
              source.files.some((file) => file.path === "old-bundled-guide.md"),
              false,
            );
            assert.equal(server.url, first.url);
            const browser = yield* Effect.promise(() =>
              client(server.url, { cookie: first.cookie, origin: server.url }),
            );
            assert.deepEqual(yield* browser.auth.session(), { authenticated: true });
            const response = yield* Effect.promise(() =>
              fetch(`${server.url}/dashboard/api/overview`, {
                headers: { cookie: first.cookie, origin: server.url },
              }),
            );
            assert.equal(response.status, 200);
            yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
            // Restart does not revive a one-use pairing grant from the old process.
            const unused = new URL(Redacted.value(first.unused.url)).hash.slice("#pair=".length);
            assert.equal(
              (yield* Effect.flip(
                browser.auth.exchange({ payload: { token: Redacted.make(unused) } }),
              ))._tag,
              "PairingRejected",
            );
            const profile = profiles[0];
            assert.ok(profile);
            yield* sdk.appProfiles.update({
              params: { app: managed.id, profile: profile.id },
              payload: { expectedRevision: profile.revision, accounts: {} },
            });
            yield* browser.auth.logout();
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* startLocalServer(settings(directory, port));
            const browser = yield* Effect.promise(() =>
              client(server.url, { cookie: first.cookie, origin: server.url }),
            );
            assert.deepEqual(yield* browser.auth.session(), { authenticated: false });
            const sdk = yield* sdkClient(server.url, settings(directory).apiKey);
            const profiles = yield* sdk.appProfiles.list({
              params: { app: first.managed.id },
              query: {},
            });
            assert.deepEqual(
              profiles.map((profile) => ({ id: profile.id, accounts: profile.accounts })),
              first.profiles.map((profile) => ({ id: profile.id, accounts: {} })),
            );
          }),
        );
        const path = yield* Path.Path;
        const rawToken = first.cookie.split("=")[1];
        assert.ok(rawToken);
        const bytes = yield* databaseBytes(path.join(directory, "browser-auth.pglite"));
        assert.equal(bytes.includes(rawToken), false);
      }),
    );
  },
);

test(
  "desktop parent hands one bootstrap through fd3 to the same server and shutdown is bounded",
  { timeout: 15_000 },
  async () => {
    await withDirectory((directory) =>
      Effect.tryPromise({
        try: async () => {
          const token = "cd".repeat(32);
          const bootstrap = Schema.decodeUnknownSync(DesktopBootstrap)({ version: 1, token });
          const child = spawn(
            process.execPath,
            [new URL("../src/bin.ts", import.meta.url).pathname, "--bootstrap-fd", "3"],
            {
              env: {
                ...process.env,
                EXECUTOR_PORT: "0",
                EXECUTOR_DATA_DIR: directory,
                EXECUTOR_API_KEY: apiKey,
                EXECUTOR_ENCRYPTION_KEY: encryptionKey,
              },
              stdio: ["ignore", "pipe", "pipe", "pipe"],
            },
          );
          const exit = new Promise<number | null>((resolve) => child.on("exit", resolve));
          const pipe = child.stdio[3];
          assert.ok(pipe && "write" in pipe && "end" in pipe);
          pipe.end(Schema.encodeSync(Schema.fromJsonString(DesktopBootstrap))(bootstrap));
          const stdout = child.stdout;
          assert.ok(stdout);
          let output = "";
          try {
            const ready = await new Promise<typeof ServerReady.Type>((resolve, reject) => {
              child.on("error", reject);
              child.on("exit", () => reject(new Error("Desktop child exited before readiness")));
              stdout.on("data", (chunk) => {
                output += String(chunk);
                const line = output.split("\n")[0];
                if (line && output.includes("\n")) {
                  try {
                    resolve(Schema.decodeUnknownSync(Schema.fromJsonString(ServerReady))(line));
                  } catch {
                    reject(new Error("Invalid readiness envelope"));
                  }
                }
              });
            });
            assert.ok(!output.includes(token));
            assert.ok(!output.includes(apiKey));
            const browser = await client(ready.url, { origin: ready.url });
            assert.equal(
              (
                await Effect.runPromise(
                  browser.auth.exchange({ payload: { token: bootstrap.token } }),
                )
              ).authenticated,
              true,
            );
            assert.equal(
              (
                await Effect.runPromise(
                  Effect.flip(browser.auth.exchange({ payload: { token: bootstrap.token } })),
                )
              )._tag,
              "PairingRejected",
            );
            // Retain an open HTTP response while shutdown begins to exercise idle connection cleanup.
            const response = await fetch(`${ready.url}/`, {
              headers: { connection: "keep-alive" },
            });
            child.kill("SIGTERM");
            const outcome = await Promise.race([
              exit,
              new Promise<never>((_, reject) => {
                const timer = setTimeout(
                  () => reject(new Error("Server did not stop within 4 seconds")),
                  4_000,
                );
                timer.unref();
                void exit.then(() => clearTimeout(timer));
              }),
            ]);
            // Effect NodeRuntime uses exit 130 for externally interrupted main fibers.
            assert.equal(outcome, 130);
            await response.body?.cancel();
          } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await exit;
          }
        },
        catch: (error) => error,
      }),
    );
  },
);

test("one session service isolates app access, persists sessions, and follows parent lifetime and revocation", async () => {
  await withDirectory((directory) =>
    Effect.gen(function* () {
      const target = {
        app: AppId.make("app_01234567-0123-0123-0123-012345678901"),
        origin: "http://app-01234567-0123-0123-0123-012345678901.localhost:4312",
      };
      const other = {
        app: AppId.make("app_01234567-0123-0123-0123-012345678902"),
        origin: "http://app-01234567-0123-0123-0123-012345678902.localhost:4312",
      };
      const cookies = yield* Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* makeLocalAuth(crypto, directory);
          const pair = yield* auth.issue();
          // A dashboard grant cannot mint an app session or be consumed at an app origin.
          assert.equal(
            (yield* Effect.flip(auth.exchangeApp(target, pair.token)))._tag,
            "PairingRejected",
          );
          const dashboard = yield* auth.exchange(pair.token);
          const parent = yield* auth.identify(Redacted.value(dashboard));
          assert.ok(parent);
          const grant = yield* auth.issueApp(target, parent);
          assert.equal((yield* Effect.flip(auth.exchange(grant.token)))._tag, "PairingRejected");
          assert.equal(
            (yield* Effect.flip(auth.exchangeApp(other, grant.token)))._tag,
            "PairingRejected",
          );
          assert.equal(
            (yield* Effect.flip(
              auth.exchangeApp({ ...target, origin: "http://wrong.localhost:4312" }, grant.token),
            ))._tag,
            "PairingRejected",
          );
          const app = yield* auth.exchangeApp(target, grant.token);
          assert.equal(
            (yield* Effect.flip(auth.exchangeApp(target, grant.token)))._tag,
            "PairingRejected",
          );
          assert.equal(yield* auth.valid(Redacted.value(app)), false);
          assert.equal(yield* auth.validApp(target, Redacted.value(dashboard)), false);
          assert.equal(yield* auth.validApp(other, Redacted.value(app)), false);
          assert.equal(
            yield* auth.validApp(
              { ...target, origin: "http://wrong.localhost:4312" },
              Redacted.value(app),
            ),
            false,
          );
          const expired = yield* auth.issueApp(target, parent);
          yield* TestClock.adjust("1 minute");
          assert.equal(
            (yield* Effect.flip(auth.exchangeApp(target, expired.token)))._tag,
            "PairingRejected",
          );
          const parallel = yield* auth.issueApp(target, parent);
          const results = yield* Effect.all(
            [
              auth.exchangeApp(target, parallel.token),
              auth.exchangeApp(target, parallel.token),
            ].map(Effect.result),
            { concurrency: 2 },
          );
          assert.equal(results.filter((result) => result._tag === "Success").length, 1);
          return { dashboard, app, unused: (yield* auth.issueApp(target, parent)).token };
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* makeLocalAuth(crypto, directory);
          assert.equal(yield* auth.valid(Redacted.value(cookies.dashboard)), true);
          assert.equal(yield* auth.validApp(target, Redacted.value(cookies.app)), true);
          assert.equal(
            (yield* Effect.flip(auth.exchangeApp(target, cookies.unused)))._tag,
            "PairingRejected",
          );
          const parent = yield* auth.identify(Redacted.value(cookies.dashboard));
          assert.ok(parent);
          const pending = yield* auth.issueApp(target, parent);
          yield* auth.revoke(Redacted.value(cookies.dashboard));
          assert.equal(yield* auth.validApp(target, Redacted.value(cookies.app)), false);
          assert.equal(
            (yield* Effect.flip(auth.exchangeApp(target, pending.token)))._tag,
            "PairingRejected",
          );
          assert.equal((yield* Effect.flip(auth.issueApp(target, parent)))._tag, "PairingRejected");
          const dashboard = yield* auth.exchange((yield* auth.issue()).token);
          const nextParent = yield* auth.identify(Redacted.value(dashboard));
          assert.ok(nextParent);
          yield* TestClock.adjust("6 days");
          const app = yield* auth.exchangeApp(
            target,
            (yield* auth.issueApp(target, nextParent)).token,
          );
          assert.equal(yield* auth.validApp(target, Redacted.value(app)), true);
          yield* TestClock.adjust("1 day");
          assert.equal(yield* auth.validApp(target, Redacted.value(app)), false);
        }),
      );
      const path = yield* Path.Path;
      const bytes = yield* databaseBytes(path.join(directory, "browser-auth.pglite"));
      assert.equal(bytes.includes(Redacted.value(cookies.app)), false);
      assert.equal(bytes.includes(Redacted.value(cookies.dashboard)), false);
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(NodeServices.layer)),
  );
});

test("opening the current session baseline preserves dashboard logins and their expiry", async () => {
  await withDirectory((directory) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const credential = "ef".repeat(32);
      const digest = yield* Effect.promise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential)),
      );
      const hash = SessionHash.make(Buffer.from(digest).toString("hex"));
      // Seed the supported baseline independently, then open it through local auth.
      const baselineSchema = schema({
        version: "1.1.0",
        tables: {
          sessions: table("browser_sessions", {
            hash: idColumn("hash", Schema.String, { type: "varchar(64)" }),
            expiresAt: column("expires_at", Schema.Date),
            access: column("access", Schema.Json).default("dashboard"),
          }),
        },
      });
      const baseline = fumadb({ namespace: "local-auth", schemas: [baselineSchema] }).client(
        sqlAdapter({ provider: "postgresql" }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const migrator = yield* baseline.createMigrator;
          yield* (yield* migrator.migrateToLatest()).execute;
          yield* baseline
            .orm("1.1.0")
            .create("sessions", { hash, expiresAt: new Date(60_000), access: "dashboard" });
        }).pipe(
          Effect.provide(pgliteLayer({ dataDir: path.join(directory, "browser-auth.pglite") })),
        ),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* makeLocalAuth(crypto, directory);
          assert.equal(yield* auth.valid(credential), true);
          const app = AppId.make("app_01234567-0123-0123-0123-012345678901");
          assert.equal(
            yield* auth.validApp({ app, origin: appOrigin(app, 4312) }, credential),
            false,
          );
          yield* TestClock.adjust("1 minute");
          assert.equal(yield* auth.valid(credential), false);
        }),
      );
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(NodeServices.layer)),
  );
});

test("app session limits cannot evict a dashboard login or another app's session", async () => {
  await withDirectory((directory) =>
    Effect.scoped(
      Effect.gen(function* () {
        const auth = yield* makeLocalAuth(crypto, directory);
        const dashboard = yield* auth.exchange((yield* auth.issue()).token);
        const parent = yield* auth.identify(Redacted.value(dashboard));
        assert.ok(parent);
        const app = AppId.make("app_01234567-0123-0123-0123-012345678901");
        const other = AppId.make("app_01234567-0123-0123-0123-012345678902");
        const target = { app, origin: appOrigin(app, 4312) };
        const otherTarget = { app: other, origin: appOrigin(other, 4312) };
        const otherCookie = yield* auth.exchangeApp(
          otherTarget,
          (yield* auth.issueApp(otherTarget, parent)).token,
        );
        for (let index = 0; index < 65; index++)
          yield* auth.exchangeApp(target, (yield* auth.issueApp(target, parent)).token);
        assert.equal(yield* auth.valid(Redacted.value(dashboard)), true);
        assert.equal(yield* auth.validApp(otherTarget, Redacted.value(otherCookie)), true);
      }),
    ),
  );
});
