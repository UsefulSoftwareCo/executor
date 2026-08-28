// Cloud: an MCP response bigger than DO storage's 128 KiB per-value cap is
// still delivered. The ui://executor/shell.html resource (~5 MB of inlined
// shell document) is the production case: the transport used to persist every
// outbound message with storage.put BEFORE writing the live SSE frame, so the
// put's failure killed the send and the client saw keepalives forever — every
// artifact widget in every remote MCP client hung, with no error anywhere
// (found live in prod, 2026-07-29). The patched transport delivers live first
// and treats persistence as best-effort, so this pins the whole path over the
// real workerd topology: POST resources/read → McpSessionDO → ASSETS-backed
// shell loader → event store skip (oversize) → live SSE frame → this client.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";

const PROTOCOL_VERSION = "2025-03-26";
const JSON_AND_SSE = "application/json, text/event-stream";

const SHELL_RESOURCE_URI = "ui://executor/shell.html";

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;
// DO storage's per-value cap; anything beyond it exercises the skip path.
const DO_VALUE_CAP_BYTES = 128 * 1024;

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
  const initialized = await postJson(mcpUrl, bearer, {
    jsonrpc: "2.0" as const,
    id: "initialize",
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "executor-e2e-oversize-response", version: "0.0.1" },
    },
  });
  const sessionId = initialized.headers.get("mcp-session-id");
  await initialized.text();
  if (initialized.status !== 200 || !sessionId) {
    throw new Error(`openSession: initialize failed (${initialized.status})`);
  }
  const notification = await postJson(
    mcpUrl,
    bearer,
    { jsonrpc: "2.0" as const, method: "notifications/initialized" },
    sessionId,
  );
  await notification.text();
  expect(notification.status, "notifications/initialized is accepted").toBe(202);
  return sessionId;
};

/** Read the POST's SSE body to completion and return the JSON-RPC payloads. */
const readSseMessages = async (
  response: Response,
): Promise<ReadonlyArray<{ readonly id?: unknown; readonly result?: unknown }>> => {
  const text = await response.text();
  const messages: Array<{ readonly id?: unknown; readonly result?: unknown }> = [];
  for (const block of text.replace(/\r/g, "").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
      .trim();
    if (data) messages.push(JSON.parse(data) as { readonly id?: unknown });
  }
  return messages;
};

scenario(
  "MCP streamable HTTP · a response beyond the DO storage value cap is delivered live (the ui:// shell resource)",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    // Artifacts are on by default, which registers the shell resource.
    const mcpUrl = target.mcpUrl;

    const sessionId = yield* Effect.promise(() => openSession(mcpUrl, bearer));

    const read = yield* Effect.promise(() =>
      postJson(
        mcpUrl,
        bearer,
        {
          jsonrpc: "2.0" as const,
          id: "read-shell",
          method: "resources/read",
          params: { uri: SHELL_RESOURCE_URI },
        },
        sessionId,
      ),
    );
    expect(read.status, "resources/read answers").toBe(200);

    // The whole regression is "the final frame never arrives": bound the read
    // so a hang fails the test instead of wedging the suite.
    const messages = yield* Effect.promise(() => readSseMessages(read)).pipe(
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () => Effect.die(new Error("shell read hung: the response frame never arrived")),
      }),
    );

    const response = messages.find((message) => message.id === "read-shell");
    expect(response, "the read's response frame arrived on the POST stream").toBeDefined();
    const result = response?.result as
      | { readonly contents?: ReadonlyArray<{ readonly text?: string }> }
      | undefined;
    const html = result?.contents?.[0]?.text ?? "";
    expect(
      html.length,
      "the document is larger than the DO storage cap, so it took the live-only path",
    ).toBeGreaterThan(DO_VALUE_CAP_BYTES);
    expect(html, "and it is the real shell document").toContain('name="executor-mcp-apps-shell"');
  }),
);
