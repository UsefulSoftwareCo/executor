import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkerEnvironment } from "alchemy/Cloudflare";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { homepage, staticDocument } from "../src/implementation/homepage.ts";
import { cloudSessionCookiePrefix } from "../src/contracts/browser.ts";
import { cloudDevelopmentOrigin } from "../src/contracts/development.ts";

/** The real route has no auth/database service to query: routing remains a cheap cookie hint. */
test("root serves the appropriate HTML without redirects or caching the cookie decision", async () => {
  const assetReads: string[] = [];
  const routes = HttpRouter.add(
    "GET",
    "/",
    homepage("executor-hosted", () => Effect.succeed(undefined)),
  ).pipe(
    HttpRouter.provideRequest(
      Layer.succeed(WorkerEnvironment, {
        ASSETS: {
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            assetReads.push(path);
            assert.ok(path === "/index.html" || path === "/dashboard.html");
            return new Response(
              path === "/index.html" ? "<h1>Marketing</h1>" : "<h1>Dashboard</h1>",
              {
                headers: { "content-type": "text/html", "cache-control": "public, max-age=3600" },
              },
            );
          },
        },
      }),
    ),
    Layer.provide(HttpServer.layerServices),
  );
  const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
  try {
    const read = (cookie?: string) =>
      web.handler(
        new Request("https://example.test/", { headers: cookie === undefined ? {} : { cookie } }),
      );
    const publicPage = await read();
    assert.equal(publicPage.status, 200);
    assert.match(await publicPage.text(), /Marketing/);
    assert.equal(publicPage.headers.get("cache-control"), "private, no-store");
    assert.equal(publicPage.headers.get("vary"), "Cookie");
    for (const cookie of [
      "executor-hosted.session_token=opaque",
      "__Secure-executor-hosted.session_token=opaque",
    ]) {
      const response = await read(cookie);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("location"), null);
      assert.match(await response.text(), /Dashboard/);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("vary"), "Cookie");
    }
    assert.deepEqual(assetReads, ["/index.html", "/dashboard.html", "/dashboard.html"]);
    for (const cookie of [
      "other=value",
      "executor-cloud-dev.session_token=other",
      "executor-hosted.session_token=",
    ])
      assert.equal((await read(cookie)).status, 200);
    const head = await web.handler(new Request("https://example.test/", { method: "HEAD" }));
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const privateHead = await web.handler(
      new Request("https://example.test/", {
        method: "HEAD",
        headers: { cookie: "executor-hosted.session_token=opaque" },
      }),
    );
    assert.equal(privateHead.status, 200);
    assert.equal(privateHead.headers.get("location"), null);
    assert.equal(await privateHead.text(), "");
    for (const path of ["/app", "/app/"]) {
      const redirected = await web.handler(
        new Request(`https://example.test${path}?source=bookmark`),
      );
      assert.equal(redirected.status, 404);
      assert.equal(redirected.headers.get("location"), null);
    }
    assert.equal(cloudSessionCookiePrefix(cloudDevelopmentOrigin), "executor-cloud-dev");
    assert.equal(cloudSessionCookiePrefix("https://v2.executor.sh"), "executor-hosted");
  } finally {
    await web.dispose();
  }
});

test("cloud asset fallback serves static dashboard documents and preserves static files and 404s", async () => {
  const routes = Layer.mergeAll(
    HttpRouter.add("GET", "/health", HttpServerResponse.text("healthy")),
    HttpRouter.add("GET", "*", staticDocument()),
  ).pipe(
    HttpRouter.provideRequest(
      Layer.succeed(WorkerEnvironment, {
        ASSETS: {
          fetch: (request: Request) => {
            const path = new URL(request.url).pathname;
            return Promise.resolve(
              path === "/org/example/apps"
                ? new Response('<html><body><div id="root"></div></body></html>', {
                    headers: { "content-type": "text/html" },
                  })
                : path === "/assets/app.js"
                  ? new Response("export {}", { headers: { "content-type": "text/javascript" } })
                  : new Response("Missing", { status: 404 }),
            );
          },
        },
      }),
    ),
    Layer.provide(HttpServer.layerServices),
  );
  const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
  try {
    const page = await web.handler(
      new Request("https://example.test/org/example/apps?tab=one", {
        headers: { accept: "text/html" },
      }),
    );
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("location"), null);
    assert.match(await page.text(), /id="root"/);
    for (const [path, status] of [
      ["/assets/app.js", 200],
      ["/health", 200],
      ["/unknown", 404],
    ] as const) {
      assert.equal((await web.handler(new Request(`https://example.test${path}`))).status, status);
    }
  } finally {
    await web.dispose();
  }
});
