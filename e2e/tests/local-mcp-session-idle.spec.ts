import { expect, layer } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { startLocalProduct } from "../support/local-workflow-engines.ts";
import { Target, driver } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const post = (origin: string, key: string, message: object, session?: string) =>
  driver("MCP request", (signal) =>
    fetch(`${origin}/mcp`, {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session === undefined
          ? {}
          : { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    }).then((response) =>
      response.text().then((body) => ({
        status: response.status,
        session: response.headers.get("mcp-session-id") ?? undefined,
        body,
      })),
    ),
  );

const initialize = (origin: string, key: string) =>
  post(origin, key, {
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "session-idle-probe", version: "1.0.0" },
    },
  });
const ping = (origin: string, key: string, session: string) =>
  Effect.map(post(origin, key, { id: 2, method: "ping" }, session), (answer) => answer.status);

layer(TestLive, { excludeTestServices: true })("Local MCP idle sessions", (it) => {
  it.effect(
    scenarios.localMcpSessionIdle.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const target = yield* Target;
          const key = Redacted.value(target.apiKey);
          const server = yield* startLocalProduct({
            EXECUTOR_MCP_SESSION_IDLE_TTL_MS: "1000",
          });
          const origin = server.origin;
          const opened = yield* initialize(origin, key);
          expect(opened.status).toBe(200);
          if (opened.session === undefined) return yield* Effect.die("no session id was issued");
          const session = opened.session;
          expect(yield* ping(origin, key, session)).toBe(200);
          yield* Effect.sleep("3 seconds");
          expect(
            yield* ping(origin, key, session),
            "an idle session must be forgotten",
          ).toBe(404);
        }),
      ),
    120_000,
  );

  it.effect(
    scenarios.localMcpSessionIdleRefreshed.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const target = yield* Target;
          const key = Redacted.value(target.apiKey);
          const server = yield* startLocalProduct({
            EXECUTOR_MCP_SESSION_IDLE_TTL_MS: "1000",
          });
          const origin = server.origin;
          const opened = yield* initialize(origin, key);
          expect(opened.status).toBe(200);
          if (opened.session === undefined) return yield* Effect.die("no session id was issued");
          const session = opened.session;
          yield* Effect.sleep("700 millis");
          expect(yield* ping(origin, key, session)).toBe(200);
          yield* Effect.sleep("700 millis");
          expect(yield* ping(origin, key, session), "inside the refreshed idle window").toBe(200);
          yield* Effect.sleep("1500 millis");
          expect(yield* ping(origin, key, session), "after the refreshed idle window").toBe(404);
        }),
      ),
    120_000,
  );
});
