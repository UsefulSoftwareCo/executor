/** Browser observer entries pass through the page's real Effect OTLP exporter. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Effect, Logger, Schema } from "effect";
import { BrowserTelemetry, makeBrowserTelemetry } from "../src/browser.ts";
import { observeBrowserPerformance } from "../src/browser-performance.ts";

const Traces = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(
          Schema.Struct({
            spans: Schema.Array(
              Schema.Struct({
                name: Schema.String,
                traceId: Schema.String,
                parentSpanId: Schema.optional(Schema.String),
                attributes: Schema.Array(
                  Schema.Struct({
                    key: Schema.String,
                    value: Schema.Record(Schema.String, Schema.Unknown),
                  }),
                ),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);

const entry = (entryType: string, startTime: number, duration: number, extra = {}) => ({
  entryType,
  startTime,
  duration,
  name: entryType,
  ...extra,
  toJSON: () => ({}),
});

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2_000;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), "the pagehide export reaches the receiver");
};

const browser = (supported: string[]) => {
  let time = 0;
  const window = Object.assign(new EventTarget(), {
    location: { pathname: "/apps", origin: "https://fixture.test" },
    performance: { now: () => time, timeOrigin: 1_000_000 },
  });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const observers = new Set<Observer>();
  class Observer implements PerformanceObserver {
    static supportedEntryTypes = supported;
    type: string | undefined;
    buffered = false;
    entries: PerformanceEntry[] = [];
    readonly callback: PerformanceObserverCallback;
    constructor(callback: PerformanceObserverCallback) {
      this.callback = callback;
    }
    observe(options?: PerformanceObserverInit) {
      this.type = options?.type;
      this.buffered = options?.buffered === true;
      observers.add(this);
    }
    disconnect() {
      observers.delete(this);
    }
    takeRecords() {
      return this.entries.splice(0);
    }
  }
  const original = new Map(
    ["window", "document", "PerformanceObserver"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: document },
    PerformanceObserver: { configurable: true, value: Observer },
  });
  return {
    window,
    document,
    observers,
    at: (value: number) => {
      time = value;
    },
    enqueue: (...entries: PerformanceEntry[]) => {
      for (const observer of observers)
        observer.entries.push(...entries.filter((e) => e.entryType === observer.type));
    },
    transition: (type: string, persisted = false) => {
      const event = new Event(type);
      Object.defineProperty(event, "persisted", { value: persisted });
      window.dispatchEvent(event);
    },
    close: () => {
      for (const [key, descriptor] of original) {
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
        else Object.defineProperty(globalThis, key, descriptor);
      }
    },
  };
};

test("page exports bounded measurements, flushes on hide and resets after BFCache restore", async () => {
  const page = browser([
    "paint",
    "largest-contentful-paint",
    "layout-shift",
    "longtask",
    "event",
    "resource",
  ]);
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    bodies.push(body);
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const { runtime } = makeBrowserTelemetry(
    Effect.succeed({
      service: "browser-performance-test",
      version: "test",
      environment: "test",
      traces: { url: `${origin}/traces` },
      logs: { url: `${origin}/logs` },
    }),
  );
  const spans = () =>
    bodies
      .filter((body) => body.includes('"resourceSpans"'))
      .flatMap((body) =>
        Schema.decodeUnknownSync(Traces)(body).resourceSpans.flatMap((r) =>
          r.scopeSpans.flatMap((s) => s.spans),
        ),
      )
      .map((span) => ({
        ...span,
        values: Object.fromEntries(
          span.attributes.map((attr) => [attr.key, Object.values(attr.value)[0]]),
        ),
      }));
  try {
    const telemetry = await runtime.runPromise(BrowserTelemetry);
    page.enqueue(
      entry("paint", 100, 0, { name: "first-contentful-paint" }),
      entry("largest-contentful-paint", 450, 0),
      entry("layout-shift", 200, 0, { value: 0.1, hadRecentInput: false }),
      entry("layout-shift", 700, 0, { value: 0.2, hadRecentInput: false }),
      entry("layout-shift", 800, 0, { value: 1, hadRecentInput: true }),
      entry("layout-shift", 2_000, 0, { value: 0.15, hadRecentInput: false }),
      entry("longtask", 300, 80),
      entry("longtask", 900, 120),
      entry("event", 1_000, 160, {
        interactionId: 1,
        processingStart: 1_040,
        processingEnd: 1_090,
      }),
      entry("event", 1_200, 104, {
        interactionId: 2,
        processingStart: 1_220,
        processingEnd: 1_280,
      }),
      entry("resource", 100, 1463, {
        name: "https://fixture.test/api/apps?secret=hidden",
        domainLookupStart: 100,
        domainLookupEnd: 105,
        connectStart: 105,
        connectEnd: 130,
        secureConnectionStart: 110,
        requestStart: 135,
        responseStart: 1561,
        responseEnd: 1563,
        serverTiming: [
          { name: "executor", description: "", duration: 163 },
          { name: "executor-trace", description: "1234567890abcdef1234567890abcdef", duration: 0 },
          { name: "cf-ray", description: "1234567890abcdef-SJC", duration: 0 },
        ],
      }),
    );
    page.at(3_000);
    await runtime.runPromise(telemetry.flush);
    await until(() => spans().some((span) => span.name === "ui.request.timing"));
    const first = spans();
    const timing = first.find((span) => span.name === "ui.request.timing");
    assert.equal(timing?.values["browser.request.duration_ms"], 1463);
    assert.equal(timing?.values["executor.handler.duration_ms"], 163);
    assert.equal(timing?.values["cloudflare.ray_id"], "1234567890abcdef");
    assert.doesNotMatch(JSON.stringify(timing), /secret|hidden/);
    const vitals = first.filter((span) => span.name === "ui.performance.vital");
    assert.equal(
      vitals.find((span) => span.values["browser.vital.name"] === "FCP")?.values[
        "browser.vital.value"
      ],
      100,
    );
    assert.equal(
      vitals.find((span) => span.values["browser.vital.name"] === "LCP")?.values[
        "browser.vital.value"
      ],
      450,
    );
    assert.ok(
      Math.abs(
        Number(
          vitals.find((span) => span.values["browser.vital.name"] === "CLS")?.values[
            "browser.vital.value"
          ],
        ) - 0.3,
      ) < 1e-9,
    );
    const tasks = first.find((span) => span.name === "ui.performance.long-tasks");
    assert.equal(tasks?.values["browser.long_task.count"], 2);
    assert.equal(tasks?.values["browser.long_task.duration_ms"], 200);
    assert.equal(tasks?.values["browser.long_task.blocking_ms"], 100);
    assert.equal(tasks?.values["browser.long_task.max_duration_ms"], 120);
    const events = first.find((span) => span.name === "ui.performance.interactions");
    assert.equal(events?.values["browser.interaction.slow_event_count"], 2);
    assert.equal(events?.values["browser.interaction.max_input_delay_ms"], 40);
    assert.equal(events?.values["browser.interaction.max_processing_ms"], 60);
    assert.ok(first.every((span) => !span.parentSpanId));
    assert.ok(
      bodies.some(
        (body) => body.includes('"resourceLogs"') && body.includes("browser.long_task.duration_ms"),
      ),
    );
    await runtime.runPromise(telemetry.flush);
    assert.equal(
      spans().length,
      first.length,
      "unchanged snapshots and empty windows are not exported again",
    );

    // Route changes close the previous route's performance window without parenting API work.
    page.enqueue(entry("longtask", 3_100, 90));
    await runtime.runPromise(telemetry.navigation({ type: "start", path: "/accounts" }));
    await runtime.runPromise(telemetry.navigation({ type: "end" }));
    page.enqueue(entry("longtask", 3_300, 100));
    page.at(3_500);
    page.document.visibilityState = "hidden";
    page.document.dispatchEvent(new Event("visibilitychange"));
    await runtime.runPromise(Effect.yieldNow);
    await until(
      () => spans().filter((span) => span.name === "ui.performance.long-tasks").length === 3,
    );
    const routeTasks = spans().filter((span) => span.name === "ui.performance.long-tasks");
    assert.deepEqual(
      routeTasks.map((span) => span.values["url.path"]),
      ["/apps", "/apps", "/accounts"],
    );

    page.enqueue(entry("longtask", 4_000, 900));
    page.transition("pagehide", true);
    await runtime.runPromise(Effect.yieldNow);
    assert.equal(page.observers.size, 0);
    page.at(10_000);
    page.document.visibilityState = "visible";
    page.transition("pageshow", true);
    await runtime.runPromise(Effect.yieldNow);
    assert.deepEqual([...page.observers].map((observer) => observer.type).sort(), [
      "event",
      "largest-contentful-paint",
      "layout-shift",
      "longtask",
      "paint",
      "resource",
    ]);
    assert.ok([...page.observers].every((observer) => !observer.buffered));
    page.enqueue(
      entry("paint", 100, 0, { name: "first-contentful-paint" }),
      entry("longtask", 10_100, 75),
    );
    page.at(10_500);
    await runtime.runPromise(telemetry.flush);
    await until(() => spans().some((span) => span.values["browser.page.restore_count"] === 1));
    const restored = spans().filter((span) => span.values["browser.page.restore_count"] === 1);
    assert.ok(restored.some((span) => span.values["browser.long_task.duration_ms"] === 75));
    assert.ok(!restored.some((span) => span.values["browser.vital.name"] === "FCP"));
    assert.ok(!spans().some((span) => span.values["browser.long_task.duration_ms"] === 900));
    await runtime.dispose();
    assert.equal(page.observers.size, 0);
    const count = bodies.length;
    page.transition("pageshow", true);
    page.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(page.observers.size, 0);
    assert.equal(bodies.length, count);
  } finally {
    await runtime.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    page.close();
  }
});

test("unsupported performance entries produce no zero-valued vitals", async () => {
  const page = browser([]);
  const messages: unknown[] = [];
  const logger = Logger.make(({ message }) => {
    messages.push(message);
  });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const telemetry = yield* observeBrowserPerformance;
        yield* telemetry.flush;
      }).pipe(Effect.scoped, Effect.provide(Logger.layer([logger]))),
    );
    assert.equal(page.observers.size, 0);
    assert.deepEqual(messages, [["ui.performance.support"]]);
  } finally {
    page.close();
  }
});
