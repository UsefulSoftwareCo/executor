/**
 * Self-host keeps a caller's 256 most recently used MCP sessions in each elicitation mode and never
 * forgets one that owns work, such as a call whose approval prompt waits for the client's answer.
 * The session owns that call only while the client can still receive it. Once the client has gone,
 * workerd aborts the request on the event stream's next write, its 5-second keep-alive, the product
 * ends the stream on that signal, and the transport releases the session with the stream. Without
 * the signal the stream ran until the prompt's 15-minute timeout, and its session stayed pinned for
 * as long.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema } from "effect";
import { appsManifest } from "../support/apps-release.ts";
import { releasedServer } from "../support/docker-release-server.ts";
import { driver } from "../support/platform.ts";

const keptSessions = 256;
/** Reads the call's event stream until the approval prompt arrives in it. */
const readUntilPrompt = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  received: string,
): Promise<void> =>
  received.includes('"elicitation/create"')
    ? Promise.resolve()
    : reader
        .read()
        .then(({ value, done }) =>
          done
            ? Promise.reject(new Error(`the call's stream ended before its prompt: ${received}`))
            : readUntilPrompt(reader, decoder, received + decoder.decode(value, { stream: true })),
        );
const files = [
  {
    path: "index.ts",
    content: `import { defineApp, mutation, object, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, { tools: router({
  approved: mutation({ input: object({}), approval: always() }, async () => "approved"),
}) });`,
  },
  appsManifest,
];

it.live(
  "released image forgets an MCP session under the bound once its approval prompt's client has gone",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* releasedServer;
        const app = yield* server.json(
          Schema.Struct({ id: Schema.String, slug: Schema.String }),
          `${server.prefix}/apps/deploy`,
          { name: "Session release", files },
        );
        const { key } = yield* server.json(
          Schema.Struct({ key: Schema.String }),
          "/api/auth/api-key/create",
          { name: "Session release" },
        );
        const url = `http://127.0.0.1:${server.port}/mcp?elicitation_mode=native`;
        const headers = (session?: string) => ({
          authorization: `Bearer ${key}`,
          "x-executor-organization": server.organization,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(session === undefined
            ? {}
            : { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" }),
        });
        const post = (message: object, session?: string) =>
          driver("POST /mcp", (signal) =>
            fetch(url, {
              method: "POST",
              signal,
              headers: headers(session),
              body: JSON.stringify({ jsonrpc: "2.0", ...message }),
            }).then((response) =>
              response.text().then((text) => ({
                status: response.status,
                session: response.headers.get("mcp-session-id") ?? undefined,
                text,
              })),
            ),
          );
        /** A native client's session, initialized and confirmed. */
        const open = Effect.gen(function* () {
          const opened = yield* post({
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: { elicitation: { form: {} } },
              clientInfo: { name: "session-release", version: "1.0.0" },
            },
          });
          expect(opened.status, opened.text).toBe(200);
          const session = opened.session!;
          expect((yield* post({ method: "notifications/initialized" }, session)).status).toBe(202);
          return session;
        });
        const openNewer = Effect.forEach(Array.from({ length: keptSessions }), () => open, {
          concurrency: 8,
          discard: true,
        });
        const ping = (session: string) =>
          post({ id: 3, method: "ping" }, session).pipe(Effect.map(({ status }) => status));

        const session = yield* open;
        const leave = new AbortController();
        yield* Effect.addFinalizer(() => Effect.sync(() => leave.abort()));
        yield* driver("receive the approval prompt of a call", () =>
          fetch(url, {
            method: "POST",
            signal: leave.signal,
            headers: headers(session),
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "execute",
                arguments: { code: `return await tools[${JSON.stringify(app.slug)}].approved({})` },
              },
            }),
          }).then((response) => {
            expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
            return readUntilPrompt(response.body!.getReader(), new TextDecoder(), "");
          }),
        );

        // While its client can still answer, the session owns the call and outlasts newer ones.
        yield* openNewer;
        expect(yield* ping(session), "a session whose prompt waits for its client").toBe(200);

        // The client goes without answering. The stream's next keep-alive finds it gone.
        leave.abort();
        yield* Effect.sleep("12 seconds");
        yield* openNewer;
        expect(yield* ping(session), "the session whose client has gone").toBe(404);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  300_000,
);
