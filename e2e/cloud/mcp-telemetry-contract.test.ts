// Cloud: the /mcp observability contract. Every MCP request must land in the
// EXPORTED trace store as an `mcp.request` span carrying the client
// fingerprint (clientInfo name/version from initialize) and the auth verdict.
// This is the per-client visibility production debugging depends on: which
// client is failing auth, which client sees slow initializes.
//
// Pins the regression shipped with the hibernatable-DO migration (2026-06-28):
// /mcp moved off the Effect app onto the raw worker Agents bridge, whose
// `Effect.runPromise` ran the auth path under Effect's no-op default tracer —
// spans were still created, but never exported. Absence looks exactly like
// health, so the contract is asserted where the data is read (the OTLP store
// the dev stack exports to, the same exporter layer that ships prod spans to
// Axiom).
import { randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target, Telemetry } from "../src/services";
import type { Identity } from "../src/target";

const JSON_AND_SSE = "application/json, text/event-stream";
const CLIENT_NAME = "executor-e2e-telemetry-probe";
const CLIENT_VERSION = "9.9.9";

const initializeRequest = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
  },
};

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

const mcpPost = (url: string | URL, bearer: string | null, body: unknown): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: {
      accept: JSON_AND_SSE,
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });

scenario(
  "MCP telemetry · an authenticated initialize exports mcp.request with the client fingerprint",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const telemetry = yield* Telemetry;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    const response = yield* Effect.promise(() => mcpPost(target.mcpUrl, bearer, initializeRequest));
    yield* Effect.promise(() => response.text());
    expect(response.status, "initialize opens a session").toBe(200);

    const span = yield* telemetry.expectSpan({
      operation: "mcp.request",
      attributes: { "mcp.client.name": CLIENT_NAME },
    });
    expect(span.span.tags["mcp.client.version"], "the client version is fingerprinted").toBe(
      CLIENT_VERSION,
    );
    expect(span.span.tags["mcp.rpc.method"], "the rpc method is visible").toBe("initialize");
    expect(span.span.tags["mcp.auth.verified"], "the auth verdict is on the span").toBe("true");
  }),
);

scenario(
  "MCP telemetry · a rejected bearer exports mcp.request with the failure fingerprint",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const telemetry = yield* Telemetry;

    // A garbage bearer: the 401 is the designed first step of the OAuth flow,
    // and per-client 401 attribution is exactly what production debugging of
    // "client X cannot log in" runs on.
    const marker = `rejected-${randomUUID().slice(0, 8)}`;
    const response = yield* Effect.promise(() =>
      mcpPost(new URL(`/mcp?probe=${marker}`, target.baseUrl), "bogus.bogus.bogus", {
        ...initializeRequest,
        params: {
          ...initializeRequest.params,
          clientInfo: { name: marker, version: CLIENT_VERSION },
        },
      }),
    );
    yield* Effect.promise(() => response.text());
    expect(response.status, "the bearer is rejected").toBe(401);

    const span = yield* telemetry.expectSpan({
      operation: "mcp.request",
      attributes: { "mcp.auth.has_bearer": "true", "mcp.auth.verified": "false" },
    });
    expect(span.span.tags["mcp.request.method"], "the request method is on the span").toBe("POST");
  }),
);
