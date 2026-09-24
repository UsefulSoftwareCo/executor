/** Real app builds and loopback HTTP exercise app origin, session, deployment, and live-data boundaries. */
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { ExecutorApi, OwnerId, SourceFiles } from "@executor-js/sdk";
import { ServerConfig } from "../src/contracts/config.ts";
import { startLocalServer } from "../src/node.ts";
import { sessionCookie } from "../src/implementation/auth.ts";
import { appOrigin, AppSignInRedirect } from "../src/contracts/app-ui.ts";

const apiKey = "synthetic-app-ui-test-key-0000000000";
const settings = (directory: string) =>
  Schema.decodeUnknownSync(ServerConfig)({
    directory,
    port: 0,
    apiKey,
    encryptionKey: "ac".repeat(32),
  });
async function event(response: Response, match: (text: string) => boolean) {
  const reader = response.body?.getReader();
  assert.ok(reader);
  let data = "";
  const deadline = setTimeout(() => {
    void reader.cancel();
  }, 8_000);
  try {
    while (!match(data)) {
      const part = await reader.read();
      if (part.done) break;
      data += new TextDecoder().decode(part.value);
    }
    assert.ok(match(data), "Expected live event");
    return data;
  } finally {
    clearTimeout(deadline);
    await reader.cancel();
  }
}

test(
  "private app SPA, direct sign-in, live data, retained assets and deployment reload events",
  { timeout: 60_000 },
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped();
          const server = yield* startLocalServer(settings(directory));
          const client = yield* HttpApiClient.make(ExecutorApi, {
            baseUrl: server.url,
            transformClient: (http) =>
              http.pipe(
                HttpClient.mapRequest(
                  HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`),
                ),
              ),
          }).pipe(Effect.provide(FetchHttpClient.layer));
          const root = yield* path.fromFileUrl(
            new URL("../../../../playground/demo-apps/live-inbox/", import.meta.url),
          );
          const files = yield* Effect.forEach(
            ["index.ts", "schema.ts", "ui/index.html", "ui/main.tsx", "ui/style.css"],
            (file) =>
              fs
                .readFileString(path.join(root, file))
                .pipe(Effect.map((content) => ({ path: file, content }))),
          );
          files.push({
            path: "package.json",
            content: JSON.stringify({ dependencies: { react: "19.2.0", "react-dom": "19.2.0" } }),
          });
          const first = yield* client.apps.deploy({
            payload: {
              owner: OwnerId.make("local"),
              name: "UI test",
              files: Schema.decodeUnknownSync(SourceFiles)(files),
            },
          });
          const second = yield* client.apps.copy({
            payload: { from: first.app.id, owner: OwnerId.make("local"), name: "Other copy" },
          });
          const foreign = yield* client.apps.copy({
            payload: { from: first.app.id, owner: OwnerId.make("other"), name: "Foreign copy" },
          });
          const link = yield* server.issuePairingLink;
          yield* Effect.promise(async () => {
            const base = server.url;
            const port = Number(new URL(base).port);
            const origin = appOrigin(first.app.id, port);
            const host = new URL(origin).host;
            const send = (url: string, options: RequestInit = {}) =>
              new Promise<Response>((resolve, reject) => {
                const outgoing: Record<string, string> = {};
                new Headers(options.headers).forEach((value, key) => {
                  outgoing[key] = value;
                });
                const req = request(
                  base + url,
                  { method: options.method ?? "GET", headers: outgoing },
                  (res) => {
                    const headers = new Headers();
                    for (const [key, value] of Object.entries(res.headers))
                      if (value !== undefined)
                        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
                    assert.ok(res.statusCode);
                    const body =
                      res.statusCode === 204
                        ? null
                        : new ReadableStream<Uint8Array>({
                            start(controller) {
                              res.on("data", (chunk: Uint8Array) => controller.enqueue(chunk));
                              res.on("end", () => controller.close());
                              res.on("error", (e) => controller.error(e));
                            },
                            cancel() {
                              req.destroy();
                            },
                          });
                    if (body === null) res.resume();
                    resolve(new Response(body, { status: res.statusCode, headers }));
                  },
                );
                req.on("error", reject);
                req.end(typeof options.body === "string" ? options.body : undefined);
              });
            const paired = await send("/auth/exchange", {
              method: "POST",
              headers: { origin: base, "content-type": "application/json" },
              body: JSON.stringify({ token: new URL(Redacted.value(link.url)).hash.slice(6) }),
            });
            assert.equal(paired.status, 200);
            const parentCookie = paired.headers.get("set-cookie")?.split(";")[0];
            assert.ok(parentCookie);
            const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
              send(url, {
                method: "POST",
                headers: { "content-type": "application/json", ...headers },
                body: JSON.stringify(body),
              });
            // App APIs and bootstrap routes are absent from the dashboard's router.
            assert.equal(
              (
                await post(
                  "/_executor/auth/start",
                  { returnTo: "/" },
                  { cookie: parentCookie, origin: base },
                )
              ).status,
              404,
            );
            assert.equal(
              (await send("/_executor/auth/callback", { headers: { accept: "text/html" } })).status,
              404,
            );
            const returnTo = "/inbox?folder=starred#message-42";
            const begin = (targetHost = host, path = returnTo) =>
              post(
                "/_executor/auth/start",
                { returnTo: path },
                { host: targetHost, origin: `http://${targetHost}` },
              );
            assert.equal(
              (await post("/_executor/auth/start", {}, { host, origin: "https://elsewhere.test" }))
                .status,
              403,
            );
            // A normal bookmark serves only the trusted bootstrap before authentication.
            const signedOut = await send("/inbox?folder=starred", {
              headers: {
                host,
                accept: "text/html",
                "sec-fetch-site": "cross-site",
                "sec-fetch-mode": "navigate",
              },
            });
            assert.equal(signedOut.status, 200);
            assert.match(await signedOut.text(), /_executor\/auth\/browser.js/);
            assert.equal((await begin(new URL(appOrigin(foreign.id, port)).host)).status, 403);
            for (const bad of [
              "https://evil.test/",
              "//evil.test/",
              "/\\evil.test/",
              "/_executor/auth/callback",
              "/%61uth/session",
              "/inbox/../_executor/auth/callback",
            ]) {
              assert.equal((await begin(host, bad)).status, 400, bad);
            }
            const started = await begin();
            assert.equal(started.status, 200);
            const attemptCookie = started.headers.get("set-cookie")?.split(";")[0];
            assert.ok(attemptCookie);
            const signIn = new URL(
              Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await started.json())
                .url,
            );
            assert.equal(signIn.origin, base);
            assert.equal(signIn.pathname, "/app-auth");
            const attempt = signIn.searchParams.get("request");
            assert.ok(attempt);
            const authorize = (cookie = parentCookie) =>
              post("/auth/apps/authorize", { request: attempt }, { cookie, origin: base });
            assert.equal((await authorize("")).status, 401);
            assert.equal(
              (
                await post(
                  "/auth/apps/authorize",
                  { request: attempt },
                  { cookie: parentCookie, origin },
                )
              ).status,
              403,
            );
            const authorized = await authorize();
            assert.equal(authorized.status, 200);
            const target = new URL(
              Redacted.value(
                Schema.decodeUnknownSync(AppSignInRedirect)(await authorized.json()).url,
              ),
            );
            assert.equal(target.origin, origin);
            assert.equal(target.pathname, "/_executor/auth/callback");
            const callbackDocument = await send("/_executor/auth/callback?route-check=1", {
              headers: { host },
            });
            assert.equal(callbackDocument.status, 200);
            assert.match(
              callbackDocument.headers.get("content-security-policy") ?? "",
              /default-src 'none'/,
            );
            const callback = Object.fromEntries(new URLSearchParams(target.hash.slice(1)));
            const complete = (targetHost = host, cookie = attemptCookie, payload = callback) =>
              post("/_executor/auth/complete", payload, {
                host: targetHost,
                origin: `http://${targetHost}`,
                cookie,
              });
            // Callback possession is not enough: it must match both the origin and the browser attempt.
            assert.equal((await complete(host, "")).status, 401);
            assert.equal((await complete(new URL(appOrigin(second.id, port)).host)).status, 401);
            const another = await begin();
            const anotherCookie = another.headers.get("set-cookie")?.split(";")[0];
            assert.ok(anotherCookie);
            assert.equal((await complete(host, anotherCookie)).status, 401);
            assert.equal(
              (await complete(host, attemptCookie, { ...callback, code: "ab".repeat(32) })).status,
              401,
            );
            assert.equal(
              (
                await post("/_executor/auth/complete", callback, {
                  host,
                  origin: base,
                  cookie: attemptCookie,
                })
              ).status,
              403,
            );
            // Duplicate dashboard requests return the same live callback (e.g. React remounts).
            assert.deepEqual(
              await (await authorize()).json(),
              Schema.encodeSync(AppSignInRedirect)({ url: Redacted.make(target.href) }),
            );
            const completions = await Promise.all([complete(), complete()]);
            assert.deepEqual(completions.map((response) => response.status).sort(), [200, 401]);
            const connected = completions.find((response) => response.status === 200);
            assert.ok(connected);
            assert.equal(connected.status, 200);
            assert.deepEqual(await connected.json(), { returnTo });
            const setCookie = connected.headers.get("set-cookie");
            assert.ok(setCookie);
            assert.match(setCookie, /HttpOnly/);
            assert.doesNotMatch(setCookie, /Domain=/);
            const cookie = setCookie.split(";")[0];
            assert.ok(cookie);
            assert.equal((await complete()).status, 401);
            const detail = await send(`/dashboard/api/apps/${first.app.id}`, {
              headers: { cookie: parentCookie, origin: base },
            });
            assert.equal(detail.status, 200);
            assert.equal(
              Schema.decodeUnknownSync(Schema.Struct({ uiUrl: Schema.String }))(await detail.json())
                .uiUrl,
              origin,
            );
            assert.equal(
              (
                await post(
                  `/dashboard/api/apps/${first.app.id}/launch`,
                  {},
                  { cookie: parentCookie, origin: base },
                )
              ).status,
              404,
            );
            const headers = { host, origin, cookie };
            for (const signal of ["traces", "logs"]) {
              const path = `/_executor/api/telemetry/${signal}`;
              assert.equal((await post(path, {}, { host, origin })).status, 401);
              assert.equal(
                (
                  await send(path, {
                    method: "POST",
                    headers: { ...headers, "content-type": "text/plain" },
                    body: "invalid",
                  })
                ).status,
                415,
              );
            }
            const token = cookie.slice(cookie.indexOf("=") + 1);
            assert.match(token, /^[a-f0-9]{64}$/);
            // A restricted token remains restricted even if placed in the dashboard's cookie.
            const copied = `${sessionCookie({ port })}=${token}`;
            assert.equal(
              (await send("/dashboard/api/overview", { headers: { cookie: copied, origin: base } }))
                .status,
              401,
            );
            const parentToken = parentCookie.slice(parentCookie.indexOf("=") + 1);
            assert.equal(
              (
                await send("/_executor/api/query", {
                  method: "POST",
                  headers: {
                    ...headers,
                    cookie: cookie.replace(token, parentToken),
                    "content-type": "application/json",
                  },
                  body: "{}",
                })
              ).status,
              401,
            );
            assert.equal((await send("/", { headers: { host } })).status, 401);
            assert.equal(
              (
                await send("/_executor/api/query", {
                  method: "POST",
                  headers: { ...headers, origin: "http://evil.localhost" },
                  body: "{}",
                })
              ).status,
              403,
            );
            assert.equal((await send("/dashboard/api/overview", { headers })).status, 404);
            // Dashboard endpoints are absent from the app router, regardless of credentials.
            assert.equal((await send("/auth/pair", { method: "POST", headers })).status, 404);
            assert.equal(
              (
                await post(
                  "/auth/apps/authorize",
                  { request: attempt },
                  { ...headers, cookie: parentCookie },
                )
              ).status,
              404,
            );
            assert.equal(
              (await send("/_executor/unknown", { headers: { ...headers, accept: "text/html" } }))
                .status,
              404,
            );
            // Top-level revisits serve authored UI directly with the app session.
            const page = await send("/inbox?folder=starred", {
              headers: {
                ...headers,
                accept: "text/html",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "cross-site",
              },
            });
            assert.equal(page.status, 200);
            const html = await page.text();
            assert.match(html, new RegExp(first.deployment.id));
            assert.match(html, /executor-context/);
            const script = /src="((?!\/_executor\/)[^"]+\.js)"/.exec(html)?.[1];
            assert.ok(script);
            const assetUrl = `/_executor/assets/${first.deployment.id}/${script}`;
            const scriptResponse = await send(assetUrl, { headers });
            assert.equal(scriptResponse.status, 200);
            assert.match(scriptResponse.headers.get("content-type") ?? "", /javascript/);
            const bundle = await scriptResponse.text();
            const head = await send(`${assetUrl}?route-check=1`, { method: "HEAD", headers });
            assert.equal(head.status, 200);
            assert.equal(await head.text(), "");
            assert.doesNotMatch(bundle, /db\.set\(messages|synthetic-app-ui-test-key/);
            assert.equal(
              (
                await send(`/_executor/assets/${first.deployment.id}/../../source/index.ts`, {
                  headers,
                })
              ).status,
              404,
            );
            const rpc = async (kind: string, input: unknown) =>
              send(`/_executor/api/${kind}`, {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify(input),
              });
            const query = { deployment: first.deployment.id, name: "listMessages", input: {} };
            assert.deepEqual(await (await rpc("query", query)).json(), []);
            // Query strings are parsed by Effect's router and never change endpoint identity.
            assert.deepEqual(
              await (await post("/_executor/api/query?route-check=1", query, headers)).json(),
              [],
            );
            const live = await rpc("subscribe", query);
            assert.equal(live.status, 200);
            const changed = event(live, (text) => text.includes("Across windows"));
            const write = await rpc("mutate", {
              deployment: first.deployment.id,
              name: "receiveMessage",
              input: { subject: "Across windows" },
            });
            assert.equal(write.status, 200);
            const savedMessage: unknown = await write.json();
            await changed;
            assert.deepEqual(await (await rpc("query", query)).json(), [savedMessage]);
            const other = await send("/_executor/api/query", {
              method: "POST",
              headers: {
                ...headers,
                host: new URL(appOrigin(second.id, port)).host,
                origin: appOrigin(second.id, port),
                "content-type": "application/json",
              },
              body: JSON.stringify(query),
            });
            assert.equal(other.status, 401);
            const stream = await send("/_executor/version", { headers });
            const versionChanged = event(
              stream,
              (text) => /event: version/.test(text) && text.split("event: version").length >= 3,
            );
            const updated = await Effect.runPromise(
              client.apps.deploy({
                payload: {
                  owner: first.app.owner,
                  app: first.app.id,
                  files: Schema.decodeUnknownSync(SourceFiles)(
                    files.map((file) =>
                      file.path === "ui/index.html"
                        ? { ...file, content: file.content.replace("Live inbox", "Updated inbox") }
                        : file,
                    ),
                  ),
                },
              }),
            );
            const events = await versionChanged;
            assert.ok(events.includes(updated.deployment.id));
            assert.equal(
              (
                await rpc("mutate", {
                  ...query,
                  name: "receiveMessage",
                  input: { id: "stale", subject: "Stale" },
                })
              ).status,
              409,
            );
            assert.equal((await send(assetUrl, { headers })).status, 200);
            assert.match(await (await send("/inbox", { headers })).text(), /Updated inbox/);
            await Effect.runPromise(
              client.apps.activate({
                params: { app: first.app.id },
                query: {},
                payload: { deployment: first.deployment.id },
              }),
            );
            assert.match(await (await send("/", { headers })).text(), /Live inbox/);
            await send("/auth/session", {
              method: "DELETE",
              headers: { cookie: parentCookie, origin: base },
            });
            assert.equal((await rpc("query", query)).status, 401);
            assert.equal((await send(assetUrl, { headers })).status, 401);
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
