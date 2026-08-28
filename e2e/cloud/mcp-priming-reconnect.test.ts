import {
  request as httpRequest,
  createServer,
  type ClientRequest,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A minimal HTTP relay that forwards to `origin` and, on `sever()`, destroys
 * the in-flight POST tools/call socket. This models a real network cut of the
 * POST tools/call SSE stream that the SDK observes as a stream read error, NOT
 * a client-initiated fetch abort. The relay itself stays up so the SDK's own
 * reconnect GET has something to connect back to.
 *
 * The cut is armed on a real event — the tools/call POST response headers — so
 * the trigger is identical whether or not the server emits a priming event.
 * `severPostMidCall()` waits for that stream to open, then cuts it a bounded
 * grace later: after any priming event has flushed and been read, but well
 * before the multi-second tool result.
 */
const startSeverableRelay = (
  originUrl: string,
): Promise<{
  readonly url: (path: string) => string;
  readonly severPostMidCall: () => Promise<void>;
  readonly close: () => void;
}> => {
  const origin = new URL(originUrl);
  // The tools/call POST hop, captured the moment its response headers arrive
  // (before any body: this is independent of whether the server emits a priming
  // event, so the trigger is identical on fixed and unfixed servers). The sever
  // must land AFTER the stream opened but BEFORE the tool result, so it fires a
  // bounded grace after the headers — long enough for a priming event to have
  // flushed and been read by the SDK, far short of the multi-second tool call.
  const SEVER_GRACE_MS = 2_000;
  let toolCallHop: { readonly upstream: ClientRequest; readonly res: ServerResponse } | null = null;
  let onToolCallOpen: (() => void) | null = null;
  const toolCallOpened = new Promise<void>((resolve) => {
    onToolCallOpen = resolve;
  });

  const server = createServer((req, res) => {
    // Detect the tools/call POST by its request body (initialize also returns
    // SSE, so a plain content-type check would arm on the wrong stream).
    const bodyChunks: Buffer[] = [];
    let isToolCall = false;
    req.on("data", (chunk: Buffer) => {
      bodyChunks.push(chunk);
      if (!isToolCall && Buffer.concat(bodyChunks).toString("utf8").includes('"tools/call"')) {
        isToolCall = true;
      }
    });
    const upstream = httpRequest(
      {
        host: origin.hostname,
        port: Number(origin.port),
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: origin.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        if (
          isToolCall &&
          (upstreamRes.headers["content-type"] ?? "").includes("text/event-stream")
        ) {
          toolCallHop = { upstream, res };
          onToolCallOpen?.();
        }
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      try {
        res.destroy();
      } catch {
        /* already torn down */
      }
    });
    req.pipe(upstream);
    req.on("aborted", () => {
      try {
        upstream.destroy();
      } catch {
        /* already torn down */
      }
    });
  });

  const severPostMidCall = async (): Promise<void> => {
    await toolCallOpened;
    await delay(SEVER_GRACE_MS);
    const hop = toolCallHop;
    if (!hop) return;
    // Destroy BOTH ends so every fetch client (undici and bun) observes a hard
    // stream error: the client-facing response socket (what the SDK's reader is
    // attached to) AND the upstream to the origin.
    for (const destroy of [
      () => hop.res.socket?.destroy(),
      () => hop.res.destroy(),
      () => hop.upstream.socket?.destroy(),
      () => hop.upstream.destroy(),
    ]) {
      try {
        destroy();
      } catch {
        /* already gone */
      }
    }
  };

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: (path: string) => `http://127.0.0.1:${port}${path}`,
        severPostMidCall,
        close: () => server.close(),
      });
    });
  });
};

scenario(
  "MCP streamable HTTP · a stock SDK client recovers a tool result after its POST stream is severed mid-call",
  { timeout: 160_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    const mcpPath = new URL(target.mcpUrl).pathname;
    const origin = new URL(target.mcpUrl).origin;
    const relay = yield* Effect.promise(() => startSeverableRelay(origin));

    // A fetch wrapper for the SDK transport that (1) records the SDK's own
    // reconnect GET (with its last-event-id) so the test can assert the SDK
    // actually reconnected, and (2) STRIPS the SDK's abort signal so a severed
    // relay socket surfaces as a stream read error (the real churn scenario),
    // not a client-side abort. Auth rides on the transport's requestInit.
    const reconnectGetEventIds: string[] = [];
    const drivenFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const lastEventId = headers.get("last-event-id");
      if (method === "GET" && lastEventId) reconnectGetEventIds.push(lastEventId);
      const { signal: _stripped, ...rest } = init ?? {};
      return fetch(url, rest);
    };

    const transport = new StreamableHTTPClientTransport(new URL(relay.url(mcpPath)), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      fetch: drivenFetch,
    });
    const client = new Client({ name: "executor-e2e-priming-reconnect", version: "0.0.1" });

    const result = yield* Effect.promise(async () => {
      try {
        await client.connect(transport);

        const marker = `MARKER_PRIMING_RECONNECT_${randomUUID()}`;
        const code = [
          `const marker = ${JSON.stringify(marker)};`,
          "await new Promise((resolve) => setTimeout(resolve, 15000));",
          "return marker;",
        ].join("\n");

        // Arm the sever: the relay cuts the POST tools/call socket a short
        // grace after the stream opens (see SEVER_GRACE_MS) — after any priming
        // event has flushed and been read by the SDK, but ~13s before the tool
        // result. The trigger (stream open) is identical on a fixed and an
        // unfixed server, so the ONLY variable is whether the client saw a
        // priming id to reconnect from.
        void relay.severPostMidCall();
        // Explicit request timeout > (call duration + reconnect backoff) so a
        // successful recover resolves well inside it; the scenario timeout is
        // the real ceiling.
        const call = await client.callTool({ name: "execute", arguments: { code } }, undefined, {
          timeout: 90_000,
        });
        return { marker, call, reconnected: reconnectGetEventIds.length > 0 };
      } finally {
        await client.close().catch(() => undefined);
        await delay(200);
        relay.close();
      }
    });

    expect(
      reconnectGetEventIds.length,
      "the stock SDK issued a reconnect GET carrying a last-event-id (it had a priming id to resume from)",
    ).toBeGreaterThan(0);
    expect(
      JSON.stringify(result.call),
      "callTool resolves with the completed tool result after the mid-call sever",
    ).toContain(result.marker);
  }),
);
