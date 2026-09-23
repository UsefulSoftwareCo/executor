/** Native routes and a real Vite fallback exercise marketing, private redirects, assets and API proxying. */
import {
  heroExperiment,
  heroVariants,
  heroDocument,
  readHeroAssignment,
  readHeroVisitor,
} from "@executor-js/marketing/experiments";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { developmentDashboard } from "../src/implementation/development-web.ts";
import { developmentRoutes } from "../scripts/development-web.ts";
import { evaluateHeroFlag } from "../src/implementation/hero-experiment.ts";
import { marketingFiles } from "../src/implementation/marketing.ts";

test(
  "cloud dev keeps native homepage/marketing routes ahead of Vite and API proxy",
  { timeout: 60_000 },
  async () => {
    let flagValue: string | false = "outcome-build";
    let flagStatus = 200;
    const evaluatedVisitors: string[] = [];
    const backend = createServer(async (request, response) => {
      if (request.url?.startsWith("/api/entry?")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ kind: "page", path: "/login", session: null, onboarding: null }),
        );
        return;
      }
      if (request.url === "/flags?v=2") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const input = Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({ api_key: Schema.String, distinct_id: Schema.String }),
          ),
        )(body);
        assert.equal(input.api_key, "synthetic-ingestion-token");
        evaluatedVisitors.push(input.distinct_id);
        response.writeHead(flagStatus, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            flags: {
              [heroExperiment.id]: {
                enabled: flagValue !== false,
                ...(flagValue === false ? {} : { variant: flagValue }),
              },
            },
            errorsWhileComputingFlags: false,
          }),
        );
        return;
      }
      response.writeHead(request.url === "/api/check" ? 200 : 404, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ api: true }));
    });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    try {
      const backendAddress = backend.address();
      assert.ok(backendAddress !== null && typeof backendAddress !== "string");
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const directory = yield* fs.makeTempDirectoryScoped();
            const dashboardRoot = path.join(directory, "dashboard");
            const publicRoot = path.join(directory, "marketing");
            yield* fs.makeDirectory(dashboardRoot);
            yield* fs.makeDirectory(path.join(publicRoot, "images"), { recursive: true });
            yield* fs.writeFileString(
              path.join(dashboardRoot, "index.html"),
              '<html><head></head><body>Dashboard<script type="module" src="/entry.js"></script></body></html>',
            );
            yield* fs.writeFileString(
              path.join(dashboardRoot, "entry.js"),
              'export const name = "dashboard"',
            );
            yield* fs.writeFileString(
              path.join(dashboardRoot, "vite.config.mjs"),
              `export default { server: { proxy: { "/api": "http://127.0.0.1:${backendAddress.port}" } } }`,
            );
            yield* fs.writeFileString(path.join(publicRoot, "index.html"), "<h1>Marketing</h1>");
            yield* fs.writeFileString(path.join(publicRoot, "about.html"), "<h1>About</h1>");
            yield* fs.writeFileString(path.join(publicRoot, "images/logo.svg"), "<svg></svg>");
            for (const variant of heroVariants) {
              const entry = path.join(publicRoot, heroDocument(variant).slice(1));
              yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
              yield* fs.writeFileString(entry, `<h1>Marketing ${variant.id}</h1>`);
            }
            const socket = createServer();
            const hmrSocket = createServer();
            yield* Layer.build(
              NodeHttpServer.layerServer(() => hmrSocket, { host: "127.0.0.1", port: 0 }),
            );
            const hmrAddress = hmrSocket.address();
            assert.ok(hmrAddress !== null && typeof hmrAddress !== "string");
            let origin = "";
            const routes = Layer.unwrap(
              Effect.gen(function* () {
                const server = yield* HttpServer.HttpServer;
                assert.ok("port" in server.address);
                origin = `http://127.0.0.1:${server.address.port}`;
                const dashboard = yield* developmentDashboard(
                  dashboardRoot,
                  hmrSocket,
                  new URL(origin),
                );
                const marketing = yield* marketingFiles(publicRoot, (visitor) =>
                  evaluateHeroFlag(
                    {
                      token: "synthetic-ingestion-token",
                      host: `http://127.0.0.1:${backendAddress.port}`,
                    },
                    visitor,
                  ),
                );
                return developmentRoutes(
                  marketing,
                  dashboard,
                  "executor-cloud-dev",
                  `http://127.0.0.1:${backendAddress.port}`,
                );
              }),
            );
            yield* Layer.build(
              HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
                Layer.provide(
                  NodeHttpServer.layer(() => socket, {
                    host: "127.0.0.1",
                    port: 0,
                    gracefulShutdownTimeout: 1_000,
                  }),
                ),
              ),
            );
            yield* Effect.addFinalizer(() => Effect.sync(() => socket.closeAllConnections()));
            yield* Effect.promise(async () => {
              for (const pathname of ["/", "/home", "/home/"]) {
                const page = await fetch(origin + pathname);
                assert.equal(page.status, 200);
                assert.match(await page.text(), /Marketing/);
              }
              const first = await fetch(origin);
              const firstBody = await first.text();
              const assignmentCookie = first.headers
                .getSetCookie()
                .find((cookie) => cookie.startsWith("executor_hero="));
              assert.ok(assignmentCookie);
              const assignment = readHeroAssignment(assignmentCookie);
              assert.ok(assignment);
              assert.ok(firstBody.includes(assignment.variant));
              const cookie = first.headers
                .getSetCookie()
                .map((value) => value.split(";")[0])
                .join("; ");
              assert.ok(cookie);
              const repeated = await fetch(origin, { headers: { cookie } });
              assert.equal(await repeated.text(), firstBody);
              assert.equal(repeated.headers.get("cache-control"), "private, no-store");
              assert.equal(repeated.headers.get("vary"), "Cookie");
              assert.equal(readHeroVisitor(cookie), assignment.visitor);
              assert.equal(
                evaluatedVisitors.at(-1),
                assignment.visitor,
                "Both evaluations use the same native PostHog identity",
              );
              const beforePreview = evaluatedVisitors.length;
              for (const variant of heroVariants) {
                const preview: Response = await fetch(`${origin}/?hero=${variant.id}`, {
                  headers: { cookie },
                });
                assert.equal(preview.status, 200);
                assert.ok((await preview.text()).includes(variant.id));
                assert.equal(preview.headers.get("x-robots-tag"), "noindex");
                assert.ok(
                  !preview.headers
                    .getSetCookie()
                    .some((value) => value.startsWith("executor_hero=")),
                );
              }
              assert.equal(
                evaluatedVisitors.length,
                beforePreview,
                "Previews never evaluate the live flag",
              );
              flagValue = "category-build";
              const changed = await fetch(origin, { headers: { cookie } });
              assert.match(
                await changed.text(),
                /category-build/,
                "PostHog's response wins over the old assignment cookie",
              );
              flagValue = "control";
              const nativeControl: Response = await fetch(origin, { headers: { cookie } });
              assert.equal(await nativeControl.text(), "<h1>Marketing category-intent</h1>");
              assert.equal(
                readHeroAssignment(nativeControl.headers.getSetCookie().join("; "))?.variant,
                "control",
                "A native control assignment stays in the experiment",
              );
              flagValue = false;
              const disabled = await fetch(origin, { headers: { cookie } });
              assert.equal(await disabled.text(), "<h1>Marketing</h1>");
              assert.ok(
                disabled.headers
                  .getSetCookie()
                  .some(
                    (value) => value.startsWith("executor_hero=") && value.includes("Max-Age=0"),
                  ),
                "Disabled flags cannot count a control exposure",
              );
              flagValue = "unknown-variant";
              assert.equal(
                await (await fetch(origin, { headers: { cookie } })).text(),
                "<h1>Marketing</h1>",
              );
              flagStatus = 503;
              assert.equal(
                await (await fetch(origin, { headers: { cookie } })).text(),
                "<h1>Marketing</h1>",
              );
              flagStatus = 200;
              flagValue = "outcome-build";
              const invalidPreview = await fetch(`${origin}/?hero=../../../dashboard`);
              assert.equal(invalidPreview.status, 400);
              const bot = await fetch(origin, { headers: { "user-agent": "Googlebot" } });
              assert.equal(await bot.text(), "<h1>Marketing</h1>");
              assert.equal(bot.headers.get("set-cookie"), null);
              const malformed = await fetch(origin, {
                headers: { cookie: "executor_hero=%broken" },
              });
              assert.equal(malformed.status, 200);
              assert.ok(
                malformed.headers
                  .getSetCookie()
                  .some((value) => value.startsWith("executor_hero=")),
              );
              const privatePage = await fetch(origin, {
                redirect: "manual",
                headers: { cookie: "executor-cloud-dev.session_token=synthetic" },
              });
              assert.equal(privatePage.status, 200);
              assert.equal(privatePage.headers.get("location"), null);
              assert.equal(privatePage.headers.get("cache-control"), "private, no-store");
              assert.equal(privatePage.headers.get("vary"), "Cookie");
              assert.match(await privatePage.text(), /Dashboard/);
              const head = await fetch(origin, {
                method: "HEAD",
                redirect: "manual",
                headers: { cookie: "executor-cloud-dev.session_token=synthetic" },
              });
              assert.equal(head.status, 200);
              assert.equal(await head.text(), "");
              assert.match(await (await fetch(origin + "/about")).text(), /About/);
              assert.match(await (await fetch(origin + "/about.html")).text(), /About/);
              assert.equal((await fetch(origin + "/images/logo.svg")).status, 200);
              assert.equal((await fetch(origin + "/images/missing.svg")).status, 404);
              assert.match(await (await fetch(origin + "/login")).text(), /Dashboard/);
              const script = await fetch(origin + "/entry.js");
              assert.equal(script.status, 200);
              assert.match(await script.text(), /dashboard/);
              const client = await (await fetch(origin + "/@vite/client")).text();
              const token = /const wsToken = "([^"]+)"/.exec(client)?.[1];
              assert.ok(token, "Vite must publish its HMR client token");
              const hmr = new WebSocket(
                `ws://127.0.0.1:${hmrAddress.port}/?token=${encodeURIComponent(token)}`,
                "vite-hmr",
              );
              try {
                await new Promise<void>((resolve, reject) => {
                  const timer = setTimeout(
                    () => reject(new Error("HMR handshake timed out")),
                    5_000,
                  );
                  hmr.addEventListener(
                    "message",
                    (event) => {
                      clearTimeout(timer);
                      try {
                        assert.deepEqual(JSON.parse(String(event.data)), { type: "connected" });
                        resolve();
                      } catch (error) {
                        reject(error);
                      }
                    },
                    { once: true },
                  );
                  hmr.addEventListener(
                    "error",
                    () => {
                      clearTimeout(timer);
                      reject(new Error("HMR connection failed"));
                    },
                    { once: true },
                  );
                });
              } finally {
                hmr.close();
              }
              const api = await fetch(origin + "/api/check", { method: "POST" });
              assert.equal(api.status, 200);
              assert.deepEqual(await api.json(), { api: true });
              const missing = await fetch(origin + "/api/missing", {
                headers: { accept: "text/html" },
              });
              assert.equal(missing.status, 404);
              assert.deepEqual(await missing.json(), { api: true });
            });
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    } finally {
      await new Promise<void>((resolve) => {
        backend.close(() => resolve());
        backend.closeAllConnections();
      });
    }
  },
);
