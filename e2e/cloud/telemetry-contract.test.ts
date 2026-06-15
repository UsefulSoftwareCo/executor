// Cloud: the telemetry contract, end to end. A tool call that hits an
// upstream error wall must be visible in the EXPORTED spans — not just
// handled gracefully for the caller. This is the regression class where the
// product silently goes dark to operators: `ToolResult.fail` rides the
// Effect success channel (a healthy-looking span), and an attribute stamped
// on the wrong span simply never arrives in the trace store, which looks
// identical to health. So the assertion runs against the OTLP store the dev
// stack actually exported to (the suite's motel — the same exporter layer
// that ships prod spans to Axiom), driving the whole production topology:
// HTTP API → execution engine → sandbox → OpenAPI invoke → a real upstream
// returning 502 → span batch → OTLP export.
//
// Pins two regressions found live in prod (2026-06-12): http.status_code was
// annotated inside the inner `OpenApi.invoke` span so the `plugin.openapi.
// invoke` span queries target carried it on 0 of ~19.5k spans; and failed
// tool calls were indistinguishable from successes on `executor.tool.execute`.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target, Telemetry } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

/** Two operations: /ok answers 200, /fail answers 502 — the success and
 *  expected-upstream-failure outcome classes the telemetry must separate. */
const upstreamSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Telemetry Upstream", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/ok": {
        get: {
          operationId: "ok",
          summary: "Succeeds",
          tags: ["probe"],
          responses: { "200": { description: "" } },
        },
      },
      "/fail": {
        get: {
          operationId: "fail",
          summary: "Always 502",
          tags: ["probe"],
          responses: { "200": { description: "" } },
        },
      },
    },
  });

/** A real upstream on 127.0.0.1: /ok → 200 JSON, anything else → 502 JSON. */
const serveUpstream = Effect.acquireRelease(
  Effect.callback<{ readonly baseUrl: string; readonly close: () => void }>((resume) => {
    const server = createServer((request, response) => {
      const ok = request.url?.startsWith("/ok") ?? false;
      response.writeHead(ok ? 200 : 502, { "content-type": "application/json" });
      response.end(ok ? '{"fine":true}' : '{"error":{"message":"bad gateway"}}');
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resume(
        Effect.succeed({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => {
            server.close();
            server.closeAllConnections();
          },
        }),
      );
    });
  }),
  (server) => Effect.sync(server.close),
);

scenario(
  "Telemetry · a failing tool call is visible in the exported spans",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: apiClient } = yield* Api;
      const telemetry = yield* Telemetry;
      const identity = yield* target.newIdentity();
      const client = yield* apiClient(api, identity);

      const upstream = yield* serveUpstream;

      // Identifier-safe slug: it becomes a property path in the sandbox code.
      const slug = IntegrationSlug.make(`telscn${randomBytes(4).toString("hex")}`);
      yield* client.openapi.addSpec({
        payload: {
          spec: { kind: "blob", value: upstreamSpec(upstream.baseUrl) },
          slug,
          baseUrl: upstream.baseUrl,
          authenticationTemplate: [
            {
              slug: "apiKey",
              type: "apiKey",
              headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
            },
          ],
        },
      });
      yield* client.connections.create({
        payload: {
          owner: "org",
          name: ConnectionName.make("main"),
          integration: slug,
          template: AuthTemplateSlug.make("apiKey"),
          value: "telemetry-scenario-token",
        },
      });

      const tools = yield* client.tools.list({ query: {} });
      const addressOf = (op: string) => {
        const tool = tools.find(
          (entry) =>
            String(entry.integration) === String(slug) && String(entry.address).endsWith(`.${op}`),
        );
        expect(tool, `the ${op} tool is in the catalog`).toBeDefined();
        return String(tool!.address);
      };
      const failAddress = addressOf("fail");
      const okAddress = addressOf("ok");

      // Drive both outcome classes through the full production path. The
      // failing call still completes for the caller — that is exactly why
      // the exported span is the only place an operator can see it.
      for (const address of [okAddress, failAddress]) {
        const execution = yield* client.executions.execute({
          payload: { code: `return await ${address}({});` },
        });
        expect(execution.status, `the ${address} execution completes`).toBe("completed");
      }

      // The failure: outcome attributes on the tool span...
      const failSpan = yield* telemetry.expectSpan({
        operation: "executor.tool.execute",
        attributes: { "mcp.tool.name": failAddress },
      });
      expect(failSpan.span.tags, "a failed tool call is marked on the exported span").toMatchObject(
        {
          "executor.tool.outcome": "fail",
          "executor.tool.error_code": "upstream_http_error",
          "executor.tool.error_status": "502",
        },
      );
      expect(
        failSpan.span.tags["executor.tenant"],
        "the span carries tenant attribution (no trace-join needed to ask 'whose error?')",
      ).toBeTruthy();

      // ...and the upstream status on the HTTP span queries actually target.
      const invokeSpan = yield* telemetry.expectSpan({
        operation: "plugin.openapi.invoke",
        attributes: { "plugin.openapi.base_url": upstream.baseUrl, "http.status_code": "502" },
      });
      expect(
        invokeSpan.span.tags["plugin.openapi.method"],
        "the invoke span names the method",
      ).toBe("GET");

      // The success is distinguishable from the failure.
      const okSpan = yield* telemetry.expectSpan({
        operation: "executor.tool.execute",
        attributes: { "mcp.tool.name": okAddress },
      });
      expect(okSpan.span.tags["executor.tool.outcome"], "a successful call is marked ok").toBe(
        "ok",
      );
    }),
  ),
);
