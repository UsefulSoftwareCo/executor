// Black-box regression for #1983: a quiet Streamable HTTP GET `/mcp` on the
// local daemon must resolve under Bun with a legal SSE comment, then release
// the standalone stream on cancel so a reconnect is not 409.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Cli, RunDir } from "../src/services";
import { withLocalServer } from "./local-server";

const MCP_POST_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
} as const;

scenario(
  "Local · a quiet MCP GET stream stays alive with an SSE keepalive comment",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const runDir = yield* RunDir;

    yield* withLocalServer(cli, runDir, (server) =>
      Effect.gen(function* () {
        const auth = { authorization: `Bearer ${server.token}` };

        const init = yield* Effect.promise(() =>
          fetch(`${server.origin}/mcp`, {
            method: "POST",
            headers: { ...MCP_POST_HEADERS, ...auth },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "e2e-local-sse-keepalive", version: "1.0.0" },
              },
            }),
          }),
        );
        expect(init.status).toBe(200);
        const sessionId = init.headers.get("mcp-session-id");
        expect(sessionId).toBeTruthy();
        yield* Effect.promise(() => init.body?.cancel() ?? Promise.resolve());

        const initialized = yield* Effect.promise(() =>
          fetch(`${server.origin}/mcp`, {
            method: "POST",
            headers: { ...MCP_POST_HEADERS, ...auth, "mcp-session-id": sessionId! },
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          }),
        );
        expect(initialized.status).toBe(202);
        yield* Effect.promise(() => initialized.body?.cancel() ?? Promise.resolve());

        const get = yield* Effect.promise(() =>
          fetch(`${server.origin}/mcp`, {
            method: "GET",
            headers: {
              ...auth,
              accept: "text/event-stream",
              "mcp-session-id": sessionId!,
            },
            signal: AbortSignal.timeout(5_000),
          }),
        );
        expect(get.status).toBe(200);
        expect(get.headers.get("content-type")).toContain("text/event-stream");
        expect(get.headers.get("mcp-session-id")).toBe(sessionId);

        const reader = get.body!.getReader();
        const first = yield* Effect.promise(() => reader.read());
        expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n");
        yield* Effect.promise(() => reader.cancel());

        const reconnect = yield* Effect.promise(() =>
          fetch(`${server.origin}/mcp`, {
            method: "GET",
            headers: {
              ...auth,
              accept: "text/event-stream",
              "mcp-session-id": sessionId!,
            },
            signal: AbortSignal.timeout(5_000),
          }),
        );
        expect(reconnect.status).toBe(200);
        expect(reconnect.headers.get("content-type")).toContain("text/event-stream");
        yield* Effect.promise(() => reconnect.body?.cancel() ?? Promise.resolve());
      }),
    );
  }),
);
