import { randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";
import { configuredMcpSessionTimeoutMs } from "../setup/mcp-session-timeouts";

const PROTOCOL_VERSION = "2025-03-26";
const JSON_AND_SSE = "application/json, text/event-stream";

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const initializeBody = {
  jsonrpc: "2.0" as const,
  id: "initialize",
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "executor-e2e-mcp-sse-replay", version: "0.0.1" },
  },
};

const initializedNotification = {
  jsonrpc: "2.0" as const,
  method: "notifications/initialized",
};

const executeBody = (id: string, code: string) => ({
  jsonrpc: "2.0" as const,
  id,
  method: "tools/call",
  params: { name: "execute", arguments: { code } },
});

const mcpHeaders = (bearer: string, sessionId?: string) => ({
  accept: JSON_AND_SSE,
  authorization: `Bearer ${bearer}`,
  "content-type": "application/json",
  "mcp-protocol-version": PROTOCOL_VERSION,
  ...(sessionId ? { "mcp-session-id": sessionId } : {}),
});

const postJson = (mcpUrl: string, bearer: string, body: unknown, sessionId?: string) =>
  fetch(mcpUrl, {
    method: "POST",
    headers: mcpHeaders(bearer, sessionId),
    body: JSON.stringify(body),
  });

const openSession = async (mcpUrl: string, bearer: string): Promise<string> => {
  const initialized = await postJson(mcpUrl, bearer, initializeBody);
  const sessionId = initialized.headers.get("mcp-session-id");
  await initialized.text();
  if (initialized.status !== 200 || !sessionId) {
    throw new Error(`openSession: initialize failed (${initialized.status})`);
  }

  const notification = await postJson(mcpUrl, bearer, initializedNotification, sessionId);
  await notification.text();
  expect(notification.status, "notifications/initialized is accepted").toBe(202);
  return sessionId;
};

type JsonRpcMessage = {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
};

class SseCapture {
  readonly messages: JsonRpcMessage[] = [];
  readonly eventIds: string[] = [];
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readonly waiters = new Map<
    string,
    Array<{ readonly resolve: (message: JsonRpcMessage) => void }>
  >();
  readonly finished: Promise<void>;

  constructor(
    private readonly response: Response,
    private readonly abortController?: AbortController,
  ) {
    this.finished = this.consume();
  }

  waitForId(id: string, timeoutMs: number): Promise<JsonRpcMessage> {
    const existing = this.messages.find((message) => message.id === id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: Promise timeout adapter for e2e polling.
        reject(new Error(`timed out waiting for JSON-RPC id ${id}`));
      }, timeoutMs);
      const waiter = {
        resolve: (message: JsonRpcMessage) => {
          clearTimeout(timeout);
          resolve(message);
        },
      };
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), waiter]);
    });
  }

  abort(reason: string): void {
    this.abortController?.abort(reason);
    this.reader?.cancel(reason).catch(() => undefined);
  }

  private async consume(): Promise<void> {
    const reader = this.response.body?.getReader();
    if (!reader) return;
    this.reader = reader;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = this.consumeBlocks(buffer);
      }
      buffer += decoder.decode();
      this.consumeBlocks(`${buffer}\n\n`);
    } catch {
      return;
    } finally {
      if (this.reader === reader) this.reader = null;
      reader.releaseLock();
    }
  }

  private consumeBlocks(buffer: string): string {
    let next = buffer;
    for (;;) {
      const index = next.indexOf("\n\n");
      if (index === -1) return next;
      const block = next.slice(0, index);
      next = next.slice(index + 2);
      this.recordBlock(block);
    }
  }

  private recordBlock(block: string): void {
    let data = "";
    let id: string | null = null;
    for (const line of block.replace(/\r/g, "").split("\n")) {
      if (line.startsWith("data:")) data += `${line.slice("data:".length).trimStart()}\n`;
      if (line.startsWith("id:")) id = line.slice("id:".length).trim();
    }
    if (id) this.eventIds.push(id);
    const trimmed = data.trim();
    if (!trimmed) return;
    const parsed = JSON.parse(trimmed) as JsonRpcMessage;
    this.messages.push(parsed);
    if (typeof parsed.id !== "string") return;
    const waiters = this.waiters.get(parsed.id) ?? [];
    this.waiters.delete(parsed.id);
    for (const waiter of waiters) waiter.resolve(parsed);
  }
}

const openGet = async (mcpUrl: string, bearer: string, sessionId: string): Promise<SseCapture> => {
  const abortController = new AbortController();
  const response = await fetch(mcpUrl, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${bearer}`,
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-session-id": sessionId,
    },
    signal: abortController.signal,
  });
  expect(response.status, "GET SSE opens").toBe(200);
  return new SseCapture(response, abortController);
};

const startPostCapture = async (
  mcpUrl: string,
  bearer: string,
  sessionId: string,
  body: unknown,
  abortController?: AbortController,
): Promise<SseCapture> => {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: mcpHeaders(bearer, sessionId),
    body: JSON.stringify(body),
    ...(abortController ? { signal: abortController.signal } : {}),
  });
  expect(response.status, "POST tools/call opens an SSE response").toBe(200);
  return new SseCapture(response, abortController);
};

const delayedCode = (marker: string, delayMs: number): string =>
  [
    `const marker = ${JSON.stringify(marker)};`,
    `await new Promise((resolve) => setTimeout(resolve, ${delayMs}));`,
    "return marker;",
  ].join("\n");

scenario(
  "MCP streamable HTTP · POST response abort is replayed on the next GET stream",
  { timeout: 160_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const sessionId = yield* Effect.promise(() => openSession(target.mcpUrl, bearer));

    const callId = `post-abort-${randomUUID()}`;
    const marker = `MARKER_POST_ABORT_${randomUUID()}`;
    const post = yield* Effect.promise(() =>
      startPostCapture(
        target.mcpUrl,
        bearer,
        sessionId,
        executeBody(callId, delayedCode(marker, 40_000)),
      ),
    );
    yield* Effect.promise(() => delay(500));
    post.abort("simulate client disconnect before result");
    yield* Effect.promise(() => post.finished.catch(() => undefined));

    yield* Effect.promise(() => delay(42_000));

    const replay = yield* Effect.promise(() => openGet(target.mcpUrl, bearer, sessionId));
    const message = yield* Effect.promise(() => replay.waitForId(callId, 15_000));
    replay.abort("scenario complete");

    expect(
      JSON.stringify(message),
      "the replayed response contains the completed tool result",
    ).toContain(marker);
    expect(replay.eventIds.length, "the replayed result carries an SSE event id").toBeGreaterThan(
      0,
    );
  }),
);

scenario(
  "MCP streamable HTTP · in-flight call survives the session idle timeout",
  { timeout: 90_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const sessionId = yield* Effect.promise(() => openSession(target.mcpUrl, bearer));

    const callId = `idle-survive-${randomUUID()}`;
    const marker = `MARKER_IDLE_SURVIVE_${randomUUID()}`;
    const delayMs = configuredMcpSessionTimeoutMs() + 2_000;
    const post = yield* Effect.promise(() =>
      startPostCapture(
        target.mcpUrl,
        bearer,
        sessionId,
        executeBody(callId, delayedCode(marker, delayMs)),
      ),
    );
    const message = yield* Effect.promise(() => post.waitForId(callId, delayMs + 20_000));

    expect(
      JSON.stringify(message),
      "the long call completes after the idle alarm window",
    ).toContain(marker);
  }),
);
