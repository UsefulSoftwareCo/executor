// Cloud: an MCP client that signs in to an account with no organization.
//
// New sign-ups happen on Executor v2, so an account that signs in through an
// MCP client's OAuth here and has no organization cannot be served: there is
// nothing to scope a session to. The client gets a Forbidden whose message
// says Executor moved and names v2's MCP URL to connect instead, rather than
// a pointer back to this web app.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

type JsonRpcError = {
  readonly jsonrpc: string;
  readonly error: { readonly code: number; readonly message: string };
};

scenario(
  "MCP sessions · an account with no organization is told to connect Executor v2's MCP URL",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity({ org: false });
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    const response = yield* Effect.promise(() =>
      fetch(target.mcpUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "executor-e2e-no-organization", version: "0.0.1" },
          },
        }),
      }),
    );
    const body = (yield* Effect.promise(() => response.json())) as JsonRpcError;

    expect(response.status, "authenticated, but there is no organization to serve").toBe(403);
    expect(
      response.headers.get("www-authenticate"),
      "no challenge: signing in again would land on the same account",
    ).toBeNull();
    expect(response.headers.get("mcp-session-id"), "no session opens").toBeNull();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe(
      "Executor has moved. This account has no organization on executor.sh/mcp: connect https://mcp.executor.sh/mcp instead. If you belong to an organization on executor.sh, reconnect this server and sign in again to choose it.",
    );
  }),
);
