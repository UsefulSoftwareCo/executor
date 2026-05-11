// ---------------------------------------------------------------------------
// Live snapshot regression suite against real public MCP servers.
//
// This file hits the network. It is gated on `MCP_PROBE_LIVE=1` so default
// test runs stay offline — set the env var to opt in:
//
//   MCP_PROBE_LIVE=1 vitest run probe-shape-real-servers.live.test.ts
//
// To refresh snapshots (after intentional probe-shape changes, or after a
// real server's behavior shifts), add `-u`:
//
//   MCP_PROBE_LIVE=1 vitest run probe-shape-real-servers.live.test.ts -u
//
// Each test fetches `<url>` with the canonical MCP `initialize` POST,
// captures the raw status / content-type / www-authenticate / body
// snippet, and runs the response through `probeMcpEndpointShape`. The
// snapshot pins both the raw signal (so a diff tells you *why* a
// classification changed) and the classification itself. Servers
// occasionally drift versions or reword error strings; that's expected
// and a snapshot update is fine.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { createExecutor, makeTestConfig } from "@executor-js/sdk";

import { mcpPlugin } from "./plugin";
import { probeMcpEndpointShape } from "./probe-shape";

const MCP_INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "executor-probe", version: "0" },
  },
});

const liveServers: ReadonlyArray<{ readonly name: string; readonly url: string }> = [
  // OAuth-protected SaaS MCP servers — most are spec-compliant with
  // `resource_metadata=` in WWW-Authenticate; a few (Atlassian, Zapier,
  // Vercel, Neon, Supabase) only carry RFC 6750 `error=` auth-params.
  { name: "asana", url: "https://mcp.asana.com/sse" },
  { name: "atlassian", url: "https://mcp.atlassian.com/v1/sse" },
  { name: "canva", url: "https://mcp.canva.com/mcp" },
  { name: "cloudflare-bindings", url: "https://bindings.mcp.cloudflare.com/sse" },
  { name: "cloudflare-observability", url: "https://observability.mcp.cloudflare.com/sse" },
  { name: "cloudflare-radar", url: "https://radar.mcp.cloudflare.com/sse" },
  { name: "figma", url: "https://mcp.figma.com/mcp" },
  { name: "github-copilot", url: "https://api.githubcopilot.com/mcp/" },
  { name: "intercom", url: "https://mcp.intercom.com/mcp" },
  { name: "linear", url: "https://mcp.linear.app/sse" },
  { name: "neon", url: "https://mcp.neon.tech/mcp" },
  { name: "netlify", url: "https://netlify-mcp.netlify.app/mcp" },
  { name: "notion", url: "https://mcp.notion.com/mcp" },
  { name: "paypal", url: "https://mcp.paypal.com/mcp" },
  { name: "replicate", url: "https://mcp.replicate.com/sse" },
  { name: "sentry", url: "https://mcp.sentry.dev/mcp/" },
  { name: "square", url: "https://mcp.squareup.com/sse" },
  { name: "stripe", url: "https://mcp.stripe.com" },
  { name: "supabase", url: "https://mcp.supabase.com/mcp" },
  { name: "tavily", url: "https://mcp.tavily.com/mcp" },
  { name: "vercel", url: "https://mcp.vercel.com/" },
  { name: "webflow", url: "https://mcp.webflow.com/sse" },
  { name: "wix", url: "https://mcp.wix.com/mcp" },
  { name: "zapier", url: "https://mcp.zapier.com/api/mcp/mcp" },

  // API-key-authenticated MCP servers (no OAuth). Cubic returns
  // JSON-RPC error envelopes; ref.tools omits WWW-Authenticate on the
  // 401 entirely so wire-shape detection rejects it (the URL-token
  // detect fallback still surfaces it as low-confidence).
  { name: "cubic", url: "https://www.cubic.dev/api/mcp" },
  { name: "reftools", url: "https://api.ref.tools/mcp" },

  // Public, unauthenticated MCP servers — should classify as `mcp`
  // with no required auth.
  { name: "context7", url: "https://mcp.context7.com/mcp" },
  { name: "deepwiki", url: "https://mcp.deepwiki.com/mcp" },
  { name: "huggingface", url: "https://huggingface.co/mcp" },
];

interface RawCapture {
  readonly status: number;
  readonly contentType: string | null;
  readonly wwwAuthenticate: string | null;
  readonly bodySnippet: string;
}

const BODY_CAP = 1024;
const REQUEST_TIMEOUT = Duration.seconds(10);
const BODY_READ_TIMEOUT = Duration.seconds(2);

// Capture the raw probe response with hard timeouts and a body-size cap.
// SSE servers stream forever, so we walk the response stream until the
// running byte count crosses BODY_CAP, then stop. Stream cancellation
// closes the underlying connection. We don't strip dynamic fields
// (server version numbers, rotating error messages) — when those drift
// we want to see it in the snapshot diff.
const readHeaderCi = (headers: Readonly<Record<string, string>>, name: string): string | null => {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
};

const captureLive = (url: string): Effect.Effect<RawCapture, unknown> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("content-type", "application/json"),
      HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
      HttpClientRequest.bodyText(MCP_INITIALIZE_BODY, "application/json"),
    );
    const response = yield* client.execute(request).pipe(Effect.timeout(REQUEST_TIMEOUT));

    let total = 0;
    const chunks = yield* response.stream.pipe(
      Stream.takeUntil((chunk: Uint8Array) => {
        total += chunk.byteLength;
        return total >= BODY_CAP;
      }),
      Stream.runCollect,
      Effect.timeout(BODY_READ_TIMEOUT),
      Effect.catch(() => Effect.succeed([] as ReadonlyArray<Uint8Array>)),
    );

    const decoder = new TextDecoder();
    const bodySnippet = chunks
      .map((c) => decoder.decode(c))
      .join("")
      .slice(0, BODY_CAP);

    return {
      status: response.status,
      contentType: readHeaderCi(response.headers, "content-type"),
      wwwAuthenticate: readHeaderCi(response.headers, "www-authenticate"),
      bodySnippet,
    } satisfies RawCapture;
  }).pipe(Effect.provide(FetchHttpClient.layer));

const live = process.env.MCP_PROBE_LIVE === "1";

// Run the full probe path (the function the React UI calls). The result
// surfaces `requiresOAuth` / `supportsDynamicRegistration`, which is what
// drives the OAuth popup vs. credentials-editor branches in
// AddMcpSource. For OAuth-protected servers we want this to be `true`;
// for API-key MCPs (Cubic) it should fail with the auth-required
// message; for unauth public servers (Hugging Face, etc.) it should
// succeed with `requiresOAuth: false` and a tool count.
type EndpointProbeOutcome =
  | {
      readonly ok: true;
      readonly connected: boolean;
      readonly requiresOAuth: boolean;
      readonly supportsDynamicRegistration: boolean;
      readonly hasToolCount: boolean;
    }
  | { readonly ok: false; readonly message: string };

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);

const messageFromUnknown = (cause: unknown): string =>
  Option.match(decodeErrorMessage(cause), {
    onNone: () => "(non-string error)",
    onSome: ({ message }) => message,
  });

const runEndpointProbe = (url: string): Effect.Effect<EndpointProbeOutcome> =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
    return yield* executor.mcp.probeEndpoint(url).pipe(
      Effect.map(
        (r) =>
          ({
            ok: true as const,
            connected: r.connected,
            requiresOAuth: r.requiresOAuth,
            supportsDynamicRegistration: r.supportsDynamicRegistration,
            // Tool counts vary across runs (servers add/remove tools).
            // Snapshot only whether we got a count, not the exact value.
            hasToolCount: typeof r.toolCount === "number",
          }) satisfies EndpointProbeOutcome,
      ),
      Effect.catch((cause) =>
        Effect.succeed({ ok: false as const, message: messageFromUnknown(cause) }),
      ),
      Effect.timeout(Duration.seconds(20)),
      Effect.catch(() =>
        Effect.succeed({ ok: false as const, message: "(probeEndpoint timeout)" }),
      ),
    );
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({ ok: false as const, message: messageFromUnknown(cause) }),
    ),
  );

describe.skipIf(!live)("probeMcpEndpointShape against live MCP servers", () => {
  for (const server of liveServers) {
    it.effect(
      `${server.name} (${server.url})`,
      () =>
        Effect.gen(function* () {
          const raw = yield* captureLive(server.url);
          const probe = yield* probeMcpEndpointShape(server.url, {
            timeoutMs: Duration.toMillis(REQUEST_TIMEOUT),
          });
          const probeEndpoint = yield* runEndpointProbe(server.url);
          expect({ raw, probe, probeEndpoint }).toMatchSnapshot();
        }),
      { timeout: Duration.toMillis(REQUEST_TIMEOUT) * 6 },
    );
  }
});
