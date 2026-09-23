/** Verify the exported request-to-DOM graph through a real authored app and collector. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";

const files = [
  {
    path: "package.json",
    content: JSON.stringify({ dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" } }),
  },
  {
    path: "index.ts",
    content: `import { defineApp, defineDatabase, table, query, mutation, object, string, array } from "apps";
const database = defineDatabase({ items: table({ text: string() }) });
export const list = query({ input: object({}), output: array(string()) }, async ({ db }) => {
  await new Promise(resolve => setTimeout(resolve, 75));
  return (await db.items.withIndex("by_creation").collect()).map(row => row.text);
});
export const add = mutation({ input: object({ text: string() }), output: string() }, async ({ db }, input) => {
  await db.items.insert(input); return input.text;
});
export const hostCache = query({ input: object({ key: string() }), output: string() }, async (_, { key }) => {
  try {
    const cache = await caches.open("executor-private-runtime-builds-v1");
    return (await cache.match(key)) === undefined ? "isolated" : "visible";
  } catch { return "unavailable"; }
});
export default defineApp({ accounts: {}, database }, { queries: { list, hostCache }, mutations: { add } });`,
  },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Observable app</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
  },
  {
    path: "ui/main.tsx",
    content: `import React from "react";
import { createRoot } from "react-dom/client";
import { array, string } from "apps";
import { createAppClient, queryReference } from "apps/client";
import { useAppQuery } from "apps/react";
import type { list } from "../index";
const client = createAppClient();
const items = client.queryAtom(queryReference<typeof list>("list"), {}, array(string()));
function App() {
  const { data, pending, error } = useAppQuery(items);
  return <main><h1>Observable app</h1><label>Draft<input /></label><p role="status">{error || (pending ? "Loading" : "Ready")}</p><ul>{data?.map(text => <li key={text}>{text}</li>)}</ul></main>;
}
createRoot(document.getElementById("root")).render(<App />);`,
  },
];

const navigationTiming = () => {
  const navigation = performance.getEntriesByType("navigation")[0];
  if (!(navigation instanceof PerformanceNavigationTiming))
    throw new Error("Navigation timing is unavailable");
  const entry = document.querySelector('script[type="module"][src]');
  if (!(entry instanceof HTMLScriptElement)) throw new Error("Browser entry missing");
  const script = performance.getEntriesByName(entry.src)[0];
  if (!(script instanceof PerformanceResourceTiming))
    throw new Error("Browser entry timing is unavailable");
  const dataReadyMs = Number(document.documentElement.getAttribute("data-e2e-ready-ms"));
  if (!Number.isFinite(dataReadyMs) || dataReadyMs <= 0)
    throw new Error("The app readiness transition was not observed");
  return {
    dataReadyMs,
    htmlHeadersMs: navigation.responseStart - navigation.requestStart,
    htmlBodyMs: navigation.responseEnd - navigation.responseStart,
    domContentLoadedMs: navigation.domContentLoadedEventEnd,
    script: {
      durationMs: script.duration,
      headersMs: script.responseStart - script.requestStart,
      bodyMs: script.responseEnd - script.responseStart,
      encodedBytes: script.encodedBodySize,
      decodedBytes: script.decodedBodySize,
    },
  };
};

layer(HostedLive, { excludeTestServices: true })("App observability", (it) => {
  it.effect(scenarios.appObservability.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const telemetry = yield* Telemetry,
          evidence = yield* Evidence;
        const target = yield* Target;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Observable ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const url = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`);
        yield* browser.login(actors.owner);
        yield* browser.use("Observe data readiness inside the page clock", (page) =>
          page.addInitScript(() => {
            const observer = new MutationObserver(() => {
              if (document.querySelector('[role="status"]')?.textContent !== "Ready") return;
              document.documentElement.setAttribute("data-e2e-ready-ms", String(performance.now()));
              observer.disconnect();
            });
            observer.observe(document, { subtree: true, childList: true, characterData: true });
          }),
        );
        const [header, timing] = yield* browser.use(
          "Open the real app and capture its subscription identity",
          (page) =>
            Promise.all([
              page
                // This crosses the app-origin sign-in round trip and asset loading,
                // not a single browser action. The suite's total deadline still applies.
                .waitForRequest((request) => request.url().endsWith("/_executor/api/subscribe"), {
                  timeout: 60_000,
                })
                .then((request) => request.headers()["traceparent"]),
              page
                .waitForResponse(
                  (response) => response.url().endsWith("/_executor/api/subscribe"),
                  {
                    timeout: 60_000,
                  },
                )
                .then((response) => response.headerValue("server-timing")),
              page.goto(url),
            ]),
        );
        const traceId = header?.match(/^00-([a-f0-9]{32})-[a-f0-9]{16}-[a-f0-9]{2}$/)?.[1];
        if (traceId === undefined)
          return yield* Effect.die("The app subscription did not propagate a valid trace");
        const serverSpan = timing?.match(/executor-span;desc="([a-f0-9]{16})"/)?.[1];
        if (serverSpan === undefined)
          return yield* Effect.die("The response did not identify its open server span");
        yield* browser.use("The initial query reaches React", (page) =>
          page.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        yield* evidence.json(
          "app-navigation-timing.json",
          yield* browser.use("Measure navigation through the initial result", (page) =>
            page.evaluate(navigationTiming),
          ),
        );
        const scriptUrl = yield* browser.use("Locate the deployed browser entry", (page) =>
          page.locator('script[type="module"][src]').evaluate((element) => {
            if (!(element instanceof HTMLScriptElement)) throw new Error("Browser entry missing");
            return element.src;
          }),
        );
        const entry = yield* browser.use("Read the retained browser entry", (page) =>
          page
            .context()
            .request.get(scriptUrl)
            .then((response) =>
              response.text().then((script) => ({
                script,
                timing: response.headers()["server-timing"],
                etag: response.headers()["etag"],
                cacheControl: response.headers()["cache-control"],
              })),
            ),
        );
        const mapName = entry.script.match(/\/\/# sourceMappingURL=(\S+)/)?.[1];
        const assetTraceId = entry.timing?.match(/executor-trace;desc="([a-f0-9]{32})"/)?.[1];
        if (assetTraceId === undefined) return yield* Effect.die("The asset has no request trace");
        if (mapName === undefined)
          return yield* Effect.die("The deployed browser entry has no source map");
        expect(entry.cacheControl).toBe("private, no-cache, must-revalidate");
        const etag = entry.etag;
        if (etag === undefined) return yield* Effect.die("The immutable asset has no ETag");
        const revalidated = yield* browser.use(
          "Revalidate bytes without downloading the bundle",
          (page) =>
            page
              .context()
              .request.get(scriptUrl, {
                headers: { "if-none-match": etag },
              })
              .then((response) =>
                response
                  .body()
                  .then((body) => ({ status: response.status(), bytes: body.byteLength })),
              ),
        );
        expect(revalidated).toEqual({ status: 304, bytes: 0 });
        expect(
          (yield* browser.use("An ETag never substitutes for an app session", (page) =>
            page.context().request.get(scriptUrl, {
              headers: { cookie: "", "if-none-match": etag },
            }),
          )).status(),
        ).toBe(401);
        expect(
          (yield* browser.use("A validator cannot make a missing file exist", (page) =>
            page.context().request.get(new URL("missing-fixture.js", scriptUrl).href, {
              headers: { "if-none-match": "*" },
            }),
          )).status(),
        ).toBe(404);
        const sourceMap = yield* browser.use("Read the authenticated source map", (page) =>
          page
            .context()
            .request.get(new URL(mapName, scriptUrl).href)
            .then((response) => response.json()),
        );
        const mapped = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            version: Schema.Literal(3),
            sources: Schema.Array(Schema.String),
            mappings: Schema.NonEmptyString,
            sourcesContent: Schema.optional(Schema.Unknown),
          }),
        )(sourceMap);
        expect(mapped.sources.some((source) => source.endsWith("ui/main.tsx"))).toBe(true);
        expect(mapped.sourcesContent).toBeUndefined();
        yield* browser.use("Keep an unfinished draft while the stream updates", (page) =>
          page.getByLabel("Draft").fill("Keep this draft"),
        );
        const privateValue = `private-value-${randomUUID()}`;
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/data/mutate`, {
            name: "add",
            input: { text: privateValue },
          })).status,
        ).toBe(200);
        yield* browser.use("A later stream result reaches the existing page", (page) =>
          page.getByRole("listitem").filter({ hasText: privateValue }).waitFor(),
        );
        expect(
          yield* browser.use("The draft survives the observed update", (page) =>
            page.getByLabel("Draft").inputValue(),
          ),
        ).toBe("Keep this draft");

        if (target.metadata.target === "cloud") {
          const deployment = yield* body(
            Schema.Struct({ build: Schema.String }),
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/source`),
          );
          const isolation = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${app.id}/data/query`,
            {
              name: "hostCache",
              input: {
                key: new URL(
                  `/_executor/runtime-build-cache/${encodeURIComponent(deployment.build)}`,
                  target.metadata.origin,
                ).href,
              },
            },
          );
          expect(isolation.status).toBe(200);
          expect(["isolated", "unavailable"]).toContain(isolation.body);
          yield* evidence.json("runtime-cache-isolation.json", { result: isolation.body });
        }

        const exported = yield* telemetry.query(traceId).pipe(
          Effect.flatMap((result) => {
            const spans = result.data.map((row) => row.span);
            const required = [
              "ui.app.first_result",
              "ui.app.subscribe",
              "http.client POST",
              "app.ui.snapshot.authorize",
              "app.ui.snapshot.send",
              "ui.app.result.receive",
              "ui.app.result.commit",
              "app.query",
            ];
            const ids = new Set(spans.map((span) => span.spanId));
            const complete =
              required.every((name) => spans.some((span) => span.operationName === name)) &&
              spans.filter((span) => span.operationName === "ui.app.result.commit").length >= 2 &&
              spans.every(
                (span) =>
                  (!span.operationName.startsWith("[missing parent") ||
                    span.spanId === serverSpan) &&
                  (span.parentSpanId === null ||
                    span.parentSpanId === serverSpan ||
                    ids.has(span.parentSpanId)),
              );
            return complete
              ? Effect.succeed(result)
              : Effect.fail(
                  new Error("The live stream trace is incomplete or has missing parents"),
                );
          }),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 40 }),
          Effect.timeout("90 seconds"),
        );
        const spans = exported.data.map((row) => row.span);
        expect(spans.some((span) => span.operationName === "sdk.apps.source")).toBe(false);
        const assetTrace = yield* telemetry.query(assetTraceId).pipe(
          Effect.flatMap((result) =>
            result.data.some((row) => row.span.operationName === "http.server GET")
              ? Effect.succeed(result)
              : Effect.fail(new Error("The asset request has not reached the collector")),
          ),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
        );
        expect(assetTrace.data.some((row) => row.span.operationName === "sdk.apps.source")).toBe(
          false,
        );
        yield* evidence.json("app-asset-trace.json", assetTrace);
        if (target.metadata.target === "cloud") {
          expect(
            assetTrace.data.some((row) => row.span.tags["executor.asset.cache"] === "hit"),
          ).toBe(true);
          expect(
            assetTrace.data.some((row) => row.span.operationName === "runtime.cloud.asset.object"),
          ).toBe(false);
          expect(
            assetTrace.data.some(
              (row) => row.span.operationName === "runtime.cloud.asset.manifest",
            ),
          ).toBe(false);
          expect(
            assetTrace.data.filter((row) => row.span.operationName === "sql.connect"),
            "An authenticated asset shares one SQL connection between app and permission reads",
          ).toHaveLength(1);
        }
        const first = spans.find((span) => span.operationName === "ui.app.first_result");
        const headers = spans.find((span) => span.operationName === "ui.app.subscribe");
        expect(first?.tags["executor.milestone.reached"]).toBe("true");
        expect(first?.durationMs).toBeGreaterThanOrEqual(headers?.durationMs ?? Infinity);
        for (const commit of spans.filter(
          (span) => span.operationName === "ui.app.result.commit",
        )) {
          const received = spans.find((span) => span.spanId === commit.parentSpanId);
          expect(received?.operationName).toBe("ui.app.result.receive");
          expect(spans.find((span) => span.spanId === received?.parentSpanId)?.operationName).toBe(
            "app.ui.snapshot.send",
          );
          expect(Number(commit.tags["browser.query.receive_to_commit_ms"])).toBeGreaterThanOrEqual(
            0,
          );
        }
        expect(JSON.stringify(exported)).not.toContain(privateValue);
        yield* evidence.json("app-trace-graph.json", exported);
        yield* browser.checkpoint("Streamed work and React commits export before disconnect");
        yield* browser.use("Close the stream normally", (page) => page.goto("about:blank"));
        const closed = yield* telemetry.query(traceId).pipe(
          Effect.flatMap((result) => {
            const spans = result.data.map((row) => row.span);
            const ids = new Set(spans.map((span) => span.spanId));
            return spans.some(
              (span) => span.spanId === serverSpan && span.operationName === "http.server POST",
            ) &&
              spans.every(
                (span) =>
                  !span.operationName.startsWith("[missing parent") &&
                  (span.parentSpanId === null || ids.has(span.parentSpanId)),
              )
              ? Effect.succeed(result)
              : Effect.fail(new Error("The closed stream still has missing parent spans"));
          }),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
          Effect.timeout("60 seconds"),
        );
        yield* evidence.json("app-trace-closed.json", closed);
        for (const sample of [1, 2]) {
          const requestHeader = yield* browser.use(`Measure normal reload ${sample}`, (page) =>
            Promise.all([
              page
                .waitForRequest((request) => request.url().endsWith("/_executor/api/subscribe"))
                .then((request) => request.headers()["traceparent"]),
              page.goto(url),
            ]).then(([header]) => header),
          );
          const reloadTraceId = requestHeader?.match(/^00-([a-f0-9]{32})-/)?.[1];
          if (reloadTraceId === undefined) return yield* Effect.die("Reload trace context missing");
          yield* browser.use(`Normal reload ${sample} displays data`, (page) =>
            page.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
          );
          yield* evidence.json(
            `app-normal-reload-${sample}-navigation.json`,
            yield* browser.use(`Measure normal reload ${sample} navigation`, (page) =>
              page.evaluate(navigationTiming),
            ),
          );
          const reloadTrace = yield* telemetry.query(reloadTraceId).pipe(
            Effect.flatMap((result) =>
              result.data.some(
                (row) =>
                  row.span.operationName === "ui.app.first_result" &&
                  row.span.tags["executor.milestone.reached"] === "true",
              )
                ? Effect.succeed(result)
                : Effect.fail(new Error("Reload timing has not reached the collector")),
            ),
            Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
          );
          yield* evidence.json(`app-normal-reload-${sample}.json`, reloadTrace);
          if (target.metadata.target === "cloud") {
            const loads = reloadTrace.data.filter(
              (row) => row.span.operationName === "runtime.cloud.build.cached",
            );
            expect(
              reloadTrace.data.filter((row) => row.span.operationName === "runtime.cloud.query"),
              "Notification registration does not repeat an unchanged initial query",
            ).toHaveLength(1);
            expect(
              loads,
              "A warm query does not load or transfer its retained server build",
            ).toHaveLength(0);
            expect(
              reloadTrace.data.some((row) => row.span.operationName === "storage.blob.get"),
              "Warm queries must not reread the server bundle from R2",
            ).toBe(false);
          }
          yield* browser.use(`Close normal reload ${sample}`, (page) => page.goto("about:blank"));
        }
        yield* browser.use("Fail only the next subscription attempt", (page) =>
          page.route("**/_executor/api/subscribe", (route) => route.abort("failed"), { times: 1 }),
        );
        const retryBatch = yield* browser.use(
          "Observe the real retry span exported by the app",
          (page) =>
            Promise.all([
              page
                .waitForRequest(
                  (request) =>
                    request.url().endsWith("/_executor/api/telemetry/traces") &&
                    (request.postData()?.includes('"retry"') ?? false),
                  { timeout: 60_000 },
                )
                .then((request) => request.postData()),
              page.goto(url),
            ]).then(([body]) => body),
        );
        const batch = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              resourceSpans: Schema.Array(
                Schema.Struct({
                  scopeSpans: Schema.Array(
                    Schema.Struct({
                      spans: Schema.Array(
                        Schema.Struct({
                          name: Schema.String,
                          traceId: Schema.String,
                          spanId: Schema.String,
                          links: Schema.optional(
                            Schema.Array(
                              Schema.Struct({ traceId: Schema.String, spanId: Schema.String }),
                            ),
                          ),
                        }),
                      ),
                    }),
                  ),
                }),
              ),
            }),
          ),
        )(retryBatch);
        const retrySpan = batch.resourceSpans
          .flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
          .find((span) => span.name === "ui.app.first_result" && span.links?.length);
        const previous = retrySpan?.links?.[0];
        if (previous === undefined || retrySpan === undefined)
          return yield* Effect.die("The retry did not carry a native span link");
        expect(previous.traceId).not.toBe(retrySpan.traceId);
        const failed = yield* telemetry.query(previous.traceId).pipe(
          Effect.flatMap((result) =>
            result.data.some(
              (row) =>
                row.span.spanId === previous.spanId &&
                row.span.status === "error" &&
                row.span.tags["executor.milestone.reached"] === "false",
            )
              ? Effect.succeed(result)
              : Effect.fail(new Error("The failed attempt is missing from the collector")),
          ),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
          Effect.timeout("60 seconds"),
        );
        yield* evidence.json("app-retry-failed-attempt.json", failed);
        yield* evidence.json("app-retry-link.json", {
          from: retrySpan.traceId,
          to: previous.traceId,
          parent: previous.spanId,
        });
        // Motel's read API omits native links. The outgoing OTLP assertion above
        // covers managed targets; the deployed Axiom adapter also exposes stored links.
        if (target.metadata.target === "cloud" && target.metadata.mode === "attached") {
          const deliveredRetry = yield* telemetry.query(retrySpan.traceId).pipe(
            Effect.flatMap((result) =>
              result.data.some(
                (row) =>
                  row.span.spanId === retrySpan.spanId &&
                  row.span.links?.some(
                    (link) => link.traceId === previous.traceId && link.spanId === previous.spanId,
                  ),
              )
                ? Effect.succeed(result)
                : Effect.fail(new Error("Axiom did not retain the retry's native span link")),
            ),
            Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
            Effect.timeout("60 seconds"),
          );
          yield* evidence.json("app-retry-delivered.json", deliveredRetry);
        }
        yield* browser.use("The retry recovers the app", (page) =>
          page.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        yield* browser.use("Close the recovered stream", (page) => page.goto("about:blank"));
        const policy = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
        );
        const shared = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: policy.revision,
            audience: { kind: "everyone" },
          }),
        );
        yield* browser.login(actors.member);
        // Test the query stream's own authorization heartbeat. The independent
        // deployment watcher otherwise reloads to a 403 page first.
        let blockedVersions = 0;
        yield* browser.use("Keep revocation observable in the query stream", (page) =>
          page.route("**/_executor/version", (route) => {
            blockedVersions++;
            return route.abort();
          }),
        );
        yield* browser.use("A permitted member opens a fresh subscription", (page) =>
          page.goto(url),
        );
        yield* browser.use("The member receives the app data", (page) =>
          page.getByRole("status").filter({ hasText: "Ready" }).waitFor({ timeout: 60_000 }),
        );
        expect(blockedVersions).toBeGreaterThan(0);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: shared.revision,
            audience: { kind: "private" },
          })).status,
        ).toBe(200);
        yield* browser.use(
          "The existing stream detects revoked access without another write",
          (page) =>
            page.getByRole("status").filter({ hasText: "Could not load app data." }).waitFor(),
        );
        expect(
          (yield* browser.use("Retained assets also require current access", (page) =>
            page.context().request.get(scriptUrl),
          )).status(),
        ).toBe(403);
        expect(
          (yield* browser.use("A matching validator cannot bypass revoked access", (page) =>
            page.context().request.get(scriptUrl, { headers: { "if-none-match": etag } }),
          )).status(),
        ).toBe(403);
        yield* browser.checkpoint("Revocation stops the open stream and protects retained assets");
      }),
    ),
  );
});
