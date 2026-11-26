import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/http";
import { randomBytes } from "node:crypto";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Collector } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });

layer(TestLive, { excludeTestServices: true })("Telemetry viewer", (it) => {
  it.effect(scenarios.telemetryViewer.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          fs = yield* FileSystem.FileSystem,
          http = yield* HttpClient.HttpClient,
          browser = yield* Browser;
        const { url } = yield* fs
          .readFileString(`${target.directory}/data/diagnostics/collector.json`)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Collector))));
        const marker = randomBytes(6).toString("hex");
        const service = `viewer-${marker}`;
        const operation = `viewer.root.${marker}`;
        const child = `viewer.child.${marker}`;
        const traceId = randomBytes(16).toString("hex");
        const root = randomBytes(8).toString("hex");
        const now = BigInt(Date.now()) * 1_000_000n;
        const post = (path: string, body: unknown) =>
          Effect.scoped(
            http.post(new URL(path, url).href, { body: HttpBody.jsonUnsafe(body) }),
          ).pipe(Effect.map(({ status }) => status));
        const resource = { attributes: [attribute("service.name", service)] };
        expect(
          yield* post("/v1/traces", {
            resourceSpans: [
              {
                resource,
                scopeSpans: [
                  {
                    scope: { name: "e2e.viewer" },
                    spans: [
                      {
                        traceId,
                        spanId: root,
                        name: operation,
                        kind: 2,
                        startTimeUnixNano: String(now - 20_000_000n),
                        endTimeUnixNano: String(now),
                        status: { code: 1 },
                      },
                      {
                        traceId,
                        spanId: randomBytes(8).toString("hex"),
                        parentSpanId: root,
                        name: child,
                        kind: 1,
                        startTimeUnixNano: String(now - 15_000_000n),
                        endTimeUnixNano: String(now - 5_000_000n),
                        status: { code: 1 },
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        ).toBe(200);
        const log = (severityText: string, severityNumber: number, text: string) => ({
          timeUnixNano: String(now),
          severityNumber,
          severityText,
          body: { stringValue: text },
          traceId,
          spanId: root,
        });
        const infoBody = `viewer info ${marker}`;
        const errorBody = `viewer error ${marker}`;
        expect(
          yield* post("/v1/logs", {
            resourceLogs: [
              {
                resource,
                scopeLogs: [
                  {
                    scope: { name: "e2e.viewer" },
                    logRecords: [log("INFO", 9, infoBody), log("ERROR", 17, errorBody)],
                  },
                ],
              },
            ],
          }),
        ).toBe(200);

        const requested: Array<string> = [];
        const assets: Array<{
          readonly path: string;
          readonly type: string;
          readonly status: number;
        }> = [];
        yield* browser.use("Record the viewer's requests", (page) =>
          Promise.resolve(
            page
              .on("request", (request) => {
                requested.push(new URL(request.url()).pathname);
              })
              .on("response", (response) => {
                const type = response.request().resourceType();
                if (type === "script" || type === "stylesheet")
                  assets.push({
                    path: new URL(response.url()).pathname,
                    type,
                    status: response.status(),
                  });
              })
              .on("requestfailed", (request) => {
                const type = request.resourceType();
                if (type === "script" || type === "stylesheet")
                  assets.push({ path: new URL(request.url()).pathname, type, status: 0 });
              }),
          ),
        );
        yield* browser.use("Open the viewer at the collector's address", (page) =>
          page.goto(new URL("/", url).href),
        );
        yield* browser.use("Find the trace in the list", (page) =>
          page.getByText(operation, { exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Read the address the root redirected to", (page) =>
            Promise.resolve(new URL(page.url()).pathname),
          ),
        ).toBe("/traces");
        yield* browser.checkpoint("Trace list");
        yield* browser.use("Open the trace", (page) =>
          page
            .getByText(operation, { exact: true })
            .click()
            .then(() => page.getByRole("heading", { level: 1, name: operation }).waitFor()),
        );
        expect(
          yield* browser.use("Read the trace's address", (page) =>
            Promise.resolve(new URL(page.url()).pathname),
          ),
        ).toBe(`/trace/${traceId}`);
        yield* browser.use("Find the child span in the waterfall", (page) =>
          page
            .getByLabel(/Trace waterfall/)
            .getByText(child, { exact: true })
            .waitFor(),
        );
        expect(
          yield* browser.use("Measure a span's bar", (page) =>
            page
              .locator('[data-span-bar="true"]')
              .first()
              .boundingBox()
              .then((box) => box?.height ?? 0),
          ),
          "the waterfall's bars are drawn",
        ).toBeGreaterThan(0);
        yield* browser.checkpoint("Trace");
        yield* browser.use("Reload the trace", (page) =>
          page
            .reload()
            .then(() => page.getByRole("heading", { level: 1, name: operation }).waitFor()),
        );
        const unknown = randomBytes(16).toString("hex");
        yield* browser.use("Open a trace the collector does not hold", (page) =>
          page
            .goto(new URL(`/trace/${unknown}`, url).href)
            .then(() => page.getByText("Trace not found").waitFor()),
        );
        yield* browser.checkpoint("Unknown trace");

        yield* browser.use("Open the logs", (page) =>
          page
            .goto(new URL("/logs", url).href)
            .then(() => page.getByPlaceholder("Search log body...").fill(marker))
            .then(() => page.getByPlaceholder("Search log body...").press("Enter"))
            .then(() => page.getByText(infoBody, { exact: true }).waitFor())
            .then(() => page.getByText(errorBody, { exact: true }).waitFor()),
        );
        yield* browser.use("Filter the logs to errors", (page) =>
          page
            .getByRole("button", { name: "ERROR", exact: true })
            .click()
            .then(() => page.getByText(infoBody, { exact: true }).waitFor({ state: "detached" }))
            .then(() => page.getByText(errorBody, { exact: true }).waitFor()),
        );
        expect(
          yield* browser.use("Read the filtered address", (page) =>
            Promise.resolve(Object.fromEntries(new URL(page.url()).searchParams)),
          ),
        ).toEqual({ body: marker, severity: "ERROR" });
        yield* browser.checkpoint("Logs filtered to errors");

        expect(requested.length, "the viewer made requests").toBeGreaterThan(0);
        expect(assets.map(({ type }) => type).sort()).toEqual(
          expect.arrayContaining(["script", "stylesheet"]),
        );
        expect(
          assets.filter(({ status }) => status !== 200),
          "every script and stylesheet the viewer requested was served",
        ).toEqual([]);
        expect(
          requested.filter((path) => path.startsWith("/api/ai")),
          "the viewer asks no AI route",
        ).toEqual([]);
        expect(requested).toContain(`/api/traces/${traceId}`);
        expect(requested).toContain("/api/logs");
      }),
    ),
  );
});
