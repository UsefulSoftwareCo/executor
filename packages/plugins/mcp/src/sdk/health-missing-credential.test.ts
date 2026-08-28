// ---------------------------------------------------------------------------
// A health check must not report `healthy` for a connection whose credential is
// missing.
//
// Rendering SKIPS a placement whose value is unresolved — that is the renderer's
// documented behaviour, and callers own the policy. The invoke path already
// refuses (it names "dialing unauthenticated" as the thing it is avoiding), and
// the OpenAPI health check reports `expired`. The MCP health check had neither,
// so it dialled unauthenticated, and any server that lists tools without auth
// answered — reporting a connection with no credential as healthy.
//
// That matters more than an ordinary wrong status: health is the signal telling
// a user to re-authenticate, so `healthy` is the one answer it must never give
// when the credential is gone.
//
// Driven against the plugin's own `checkHealth` rather than through a live
// connection, because the precondition under test — a connection that EXISTS but
// whose credential does not resolve — is exactly the state the connection APIs
// are designed to prevent you from creating. Calling the seam directly is the
// only way to construct it without faking the thing being tested.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { mcpPlugin } from "./plugin";

const ENDPOINT = "https://mcp.example.test/sse";

/** A remote MCP integration whose api-key method needs one input. */
const config = {
  transport: "remote" as const,
  endpoint: ENDPOINT,
  remoteTransport: "streamable-http" as const,
  authenticationTemplate: [
    {
      slug: "api_key",
      kind: "apikey" as const,
      placements: [{ carrier: "header" as const, name: "X-Api-Key", variable: "token" }],
    },
  ],
};

/** Answers anything with 200 — standing in for a server that lists tools with no
 *  auth at all, which is what turned a missing credential into `healthy`. */
const permissiveClientLayer = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch)(
      (async (_input: RequestInfo | URL) =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    ),
  ),
);

const checkHealthWith = (values: Record<string, string | null>) =>
  Effect.gen(function* () {
    const plugin = mcpPlugin();
    const checkHealth = (plugin as { readonly checkHealth?: unknown }).checkHealth;
    if (typeof checkHealth !== "function") {
      return yield* Effect.die("mcpPlugin no longer exposes checkHealth");
    }
    return yield* (
      checkHealth as (input: {
        readonly ctx: { readonly httpClientLayer: typeof permissiveClientLayer };
        readonly credential: {
          readonly config: typeof config;
          readonly values: Record<string, string | null>;
          readonly template: string;
          readonly connection: string;
          readonly integration: string;
        };
      }) => Effect.Effect<{ readonly status: string; readonly detail?: string }>
    )({
      ctx: { httpClientLayer: permissiveClientLayer },
      credential: {
        config,
        values,
        template: "api_key",
        connection: "main",
        integration: "health_mcp",
      },
    });
  });

describe("MCP health check with an unresolved credential", () => {
  it.effect("reports expired, not healthy, when the api-key input is missing", () =>
    Effect.gen(function* () {
      const health = yield* checkHealthWith({});

      // The fetch above answers everything 200, so nothing except the gate
      // stands between this and `healthy`.
      expect(health.status).not.toBe("healthy");
      expect(health.status).toBe("expired");
      expect(String(health.detail ?? "")).toContain("token");
    }),
  );

  it.effect("does not short-circuit when the input IS resolved", () =>
    Effect.gen(function* () {
      // The other half: a gate that returned `expired` unconditionally would
      // satisfy the test above while breaking every healthy connection.
      const health = yield* checkHealthWith({ token: "sk-present" });

      expect(health.status).not.toBe("expired");
    }),
  );
});
