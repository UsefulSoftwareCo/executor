// Cloud: the MCP OAuth token lifecycle, walked the way real MCP clients walk
// it — discovery, scope selection, token grant, real access-token expiry
// (compressed TTL, no fake clocks), and refresh recovery.
//
// The two scenarios differ in ONE thing: how the client picks scopes. A
// spec-faithful client (OpenCode, Poke, mcporter) requests exactly what our
// protected-resource metadata advertises in scopes_supported; a hardcoding
// client (Claude Code, Codex) ignores the metadata and always asks for
// `openid profile email offline_access`. AuthKit only issues a refresh token
// when offline_access is granted, so if our metadata advertises no scopes,
// spec-faithful clients are stranded at the first expiry and the user must
// re-run the browser flow — the field report of "I have to re-authenticate
// every day."
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario, type ScenarioContext } from "../src/scenario";
import {
  HARDCODED_SCOPES_CLIENT,
  SPEC_FAITHFUL_CLIENT,
  type McpClientScopePolicy,
} from "../src/surfaces/mcp";

const TTL_SECONDS = 3;

/** A minimal authenticated MCP request; the bearer's validity decides the status. */
const probe = (mcpUrl: string, bearer: string): Effect.Effect<number> =>
  Effect.promise(async () => {
    const response = await fetch(mcpUrl, {
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
          clientInfo: { name: "executor-e2e-oauth-lifecycle", version: "0.0.1" },
        },
      }),
    });
    await response.body?.cancel();
    return response.status;
  });

const survivesTokenExpiry = (ctx: ScenarioContext, client: McpClientScopePolicy) =>
  Effect.gen(function* () {
    const identity = yield* ctx.target.newIdentity();
    const email = identity.credentials?.email ?? identity.label;

    // The client discovers our protected-resource metadata and picks scopes
    // by its own policy — this is the only step where the two clients differ.
    const advertised = yield* ctx.mcp.advertisedScopes();
    const requested = client.scopesToRequest(advertised);
    const tokens = yield* ctx.mcp.mintTokens(email, {
      scopes: requested,
      accessTokenTtlSeconds: TTL_SECONDS,
    });

    expect(yield* probe(ctx.target.mcpUrl, tokens.accessToken), "the fresh token works").toBe(200);

    // The access token genuinely expires (the authorization server honors the
    // compressed TTL) and the resource server genuinely rejects it.
    yield* Effect.sleep(`${TTL_SECONDS + 2} seconds`);
    expect(
      yield* probe(ctx.target.mcpUrl, tokens.accessToken),
      "the expired token is rejected",
    ).toBe(401);

    // The only non-interactive way back is a refresh token. A grant without
    // one strands the user in the browser flow at every expiry.
    expect(
      tokens.refreshToken,
      `${client.name} requested [${requested.join(" ")}] and must end up holding a refresh token`,
    ).not.toBeNull();
    const refreshed = yield* tokens.refresh();
    expect(
      yield* probe(ctx.target.mcpUrl, refreshed.accessToken),
      "the refreshed token restores access",
    ).toBe(200);
  });

scenario(
  "MCP OAuth lifecycle · a spec-faithful client (OpenCode) survives access-token expiry",
  { needs: ["mcp-oauth"] },
  (ctx) => survivesTokenExpiry(ctx, SPEC_FAITHFUL_CLIENT),
);

scenario(
  "MCP OAuth lifecycle · a scope-hardcoding client (Claude Code) survives access-token expiry",
  { needs: ["mcp-oauth"] },
  (ctx) => survivesTokenExpiry(ctx, HARDCODED_SCOPES_CLIENT),
);
