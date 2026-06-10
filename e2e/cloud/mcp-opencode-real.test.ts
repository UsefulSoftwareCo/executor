// Cloud: the OpenCode daily re-auth, reproduced with the REAL opencode
// binary. Nothing about the client is modeled — OpenCode runs its own
// discovery against our published metadata, its own DCR, its own scope
// selection, its own token storage. The only theater is the browser hop
// (an open(1) shim captures the URL and a fetch with login_hint plays the
// signed-in human) and time (the emulator's seeded default TTL compresses
// "a day" into seconds).
//
// Field report this encodes: OpenCode users must re-authenticate the
// executor MCP every day, while Claude Code sessions persist. The scenario
// asserts the experience a user deserves — authenticate once, stay signed
// in across an access-token expiry. It stays red until the server gives
// spec-faithful clients a way to refresh.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { makeOpenCodeHome, opencode, opencodeAuth } from "../src/clients/opencode";
import { WORKOS_EMULATOR_PORT } from "../targets/cloud";

const SERVER_NAME = "executor";
const TTL_SECONDS = 15;

/** Compress (or restore) the authorization server's access-token lifetime. */
const seedAccessTokenTtl = (ttlSeconds: number | null): Effect.Effect<void> =>
  Effect.promise(async () => {
    const response = await fetch(`http://127.0.0.1:${WORKOS_EMULATOR_PORT}/_emulate/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oauth: { default_access_token_ttl_seconds: ttlSeconds } }),
    });
    if (!response.ok) throw new Error(`seeding emulator TTL failed (${response.status})`);
  });

scenario(
  "MCP OAuth lifecycle · the real OpenCode binary stays signed in across token expiry",
  { needs: ["mcp-oauth", "opencode"], timeout: 180_000 },
  (ctx) =>
    Effect.gen(function* () {
      const identity = yield* ctx.target.newIdentity();
      const email = identity.credentials?.email ?? identity.label;
      const home = makeOpenCodeHome(SERVER_NAME, ctx.target.mcpUrl);

      yield* seedAccessTokenTtl(TTL_SECONDS);
      yield* Effect.gen(function* () {
        // OpenCode completes MCP OAuth for real: discovery, DCR, PKCE,
        // its own scope request, its own token store.
        const auth = yield* opencodeAuth(home, SERVER_NAME, email);
        expect(auth.exitCode, `opencode mcp auth completes\n${auth.output}`).toBe(0);

        // While the token is fresh, OpenCode is a working MCP client.
        const fresh = yield* opencode(home, ["mcp", "list"]);
        expect(fresh.output, "OpenCode connects on a fresh token").toContain("connected");

        // The access token genuinely expires (server-honored TTL, no fakes).
        yield* Effect.sleep(`${TTL_SECONDS + 3} seconds`);

        // The experience a user deserves: still signed in. OpenCode requested
        // exactly the scopes our metadata advertises; whether it ended up
        // holding a refresh token decides this assertion — that is the bug.
        const tokens = home.storedTokens(SERVER_NAME);
        const expired = yield* opencode(home, ["mcp", "list"]);
        expect(
          expired.output,
          `OpenCode stays signed in across token expiry (its store holds ${
            tokens?.refreshToken ? "a refresh token" : "NO refresh token"
          })`,
        ).toContain("connected");
      }).pipe(Effect.ensuring(seedAccessTokenTtl(null)));
    }),
);
