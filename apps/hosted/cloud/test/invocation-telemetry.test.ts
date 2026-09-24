import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { Effect } from "effect";
import { telemetryLayer } from "@executor-js/telemetry";
import { invocationSummary, recordInvocations } from "../src/implementation/invocation-summary.ts";

const invocation = {
  eventTimestamp: 1_800_000_000_000,
  scriptName: "fixture-api",
  scriptVersion: { id: "fixture-version" },
  cpuTime: 32,
  wallTime: 211,
  outcome: "ok",
  truncated: false,
  event: {
    request: {
      method: "GET",
      url: "https://fixture.test/callback?token=private-token",
      headers: {
        authorization: "Bearer private-token",
        cookie: "private-cookie",
        "cf-ray": "1234567890abcdef-SJC",
        traceparent: "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
      },
    },
    response: { status: 200 },
  },
  logs: [
    { message: ["private-console-message"] },
    { message: [{ type: "alchemy.phase", name: "alchemy.runtime.initialize", durationMs: 0 }] },
    { message: [{ type: "alchemy.phase", name: "alchemy.response", durationMs: 175 }] },
    {
      message: [JSON.stringify({ type: "alchemy.phase", name: "alchemy.cleanup", durationMs: 36 })],
    },
  ],
  exceptions: [{ message: "private-error-message" }],
};

test("native CPU and full invocation time survive without exporting provider payloads", async () => {
  const summary = await Effect.runPromise(invocationSummary(invocation));
  assert.equal(summary["cloudflare.cpu_time_ms"], 32);
  assert.equal(summary["cloudflare.wall_time_ms"], 211);
  assert.equal(summary["executor.response_ready_ms"], 175);
  assert.equal(summary["executor.cleanup_ms"], 36);
  assert.equal(summary["executor.phase_clock"], "cloudflare-io");
  assert.equal(summary["executor.initialization_observed"], true);
  assert.equal(summary["executor.initialize_ms"], 0);
  assert.equal(summary["cloudflare.event.timestamp_ms"], invocation.eventTimestamp);
  assert.equal(summary["cloudflare.ray_id"], "1234567890abcdef");
  assert.equal(summary["executor.trace_id"], "1234567890abcdef1234567890abcdef");
  assert.equal(summary["cloudflare.script_version.id"], "fixture-version");
  assert.doesNotMatch(JSON.stringify(summary), /private|callback|url|headers|cookie/);
  const scheduled = await Effect.runPromise(
    invocationSummary({ ...invocation, event: { cron: "* * * * *" } }),
  );
  assert.equal(scheduled["cloudflare.wall_time_ms"], 211);
  assert.equal(scheduled["cloudflare.ray_id"], undefined);
});

test("native stream exceptions expose categories without provider messages", async () => {
  const summary = await Effect.runPromise(
    invocationSummary({
      ...invocation,
      outcome: "exception",
      exceptions: [
        { message: "Network connection lost: private-token" },
        { message: "internal error; reference = private-reference" },
        { message: "private-error-message" },
      ],
    }),
  );
  assert.equal(summary["cloudflare.exception.count"], 3);
  assert.equal(summary["cloudflare.exception.codes"], "disconnected,internal,unclassified");
  assert.doesNotMatch(JSON.stringify(summary), /private|reference|Network|message/);
});

test("the real event exporter delivers valid summaries and a safe decoding failure", async () => {
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push(body);
    response.writeHead(200).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    await Effect.runPromise(
      recordInvocations([{ ...invocation, cpuTime: "bad" }, invocation]).pipe(
        Effect.provide(
          telemetryLayer(
            {
              service: "fixture",
              version: "test",
              environment: "test",
              logs: { url: `http://127.0.0.1:${address.port}` },
              traces: { url: `http://127.0.0.1:${address.port}` },
              metrics: { url: `http://127.0.0.1:${address.port}` },
              metricsProtocol: "http/json",
            },
            "event",
          ),
        ),
      ),
    );
    const payload = received.join("\n");
    assert.match(payload, /cloudflare.invocation/);
    assert.match(payload, /Invalid Cloudflare invocation timing record/);
    assert.match(payload, /cloudflare.cpu_time_ms/);
    assert.match(payload, /cloudflare.exception.count/);
    assert.match(payload, /cloudflare.exception.codes/);
    assert.match(payload, /unclassified/);
    assert.match(payload, /1234567890abcdef/);
    assert.match(payload, /"links":\[/);
    assert.match(payload, /executor.worker.cpu_ms/);
    assert.match(payload, /executor.worker.wall_ms/);
    assert.doesNotMatch(payload, /private-token|private-cookie|private-console|private-error/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
