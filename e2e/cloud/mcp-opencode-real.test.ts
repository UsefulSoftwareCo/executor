// Cloud: the OpenCode daily re-auth, reproduced with the REAL opencode
// binary in a REAL terminal. The whole session runs in one recorded PTY —
// the run's terminal.cast replays exactly what a user at a shell would see:
// authenticate, connected, wait out the token, suddenly "needs
// authentication" again.
//
// Nothing about the client is modeled: OpenCode runs its own discovery
// against our published metadata, its own DCR, its own scope selection, its
// own token storage. The only theater is the browser hop (an open(1) shim
// captures the URL and a fetch with login_hint plays the signed-in human)
// and time (the emulator's seeded default TTL compresses "a day" into
// seconds). The scenario asserts the experience a user deserves —
// authenticate once, stay signed in across an access-token expiry. It stays
// red until the server gives spec-faithful clients a way to refresh.
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { completeOAuthConsent, makeOpenCodeHome } from "../src/clients/opencode";
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
      yield* ctx.cli
        .session(
          ["bash", "--norc"],
          async (term) => {
            // Sentinels are typed quoted ("DO""NE") so waitForText can't
            // match the echoed command line, only the command's output.
            const sh = async (line: string, sentinel: string, timeoutMs: number) => {
              await term.keyboard.type(
                `${line}; echo ${sentinel.slice(0, 2)}""${sentinel.slice(2)}`,
              );
              await term.keyboard.press("Enter");
              await term.screen.waitForText(sentinel, { timeoutMs });
              return term.screen.text();
            };

            // OpenCode completes MCP OAuth for real: discovery, DCR, PKCE,
            // its own scope request, its own token store.
            const consent = completeOAuthConsent(home, email, home.openedUrls().length);
            const auth = await sh(`opencode mcp auth ${SERVER_NAME}`, "AUTH-DONE", 60_000);
            await consent;
            expect(auth, "opencode mcp auth completes").not.toContain("failed");

            // While the token is fresh, OpenCode is a working MCP client.
            const fresh = await sh("clear; opencode mcp list", "FRESH-DONE", 60_000);
            expect(fresh, "OpenCode connects on a fresh token").toContain("connected");

            // The access token genuinely expires on camera (server-honored
            // TTL, no fakes), then the same command runs again.
            const expired = await sh(
              `sleep ${TTL_SECONDS + 3}; clear; opencode mcp list`,
              "EXPIRED-DONE",
              (TTL_SECONDS + 3) * 1000 + 60_000,
            );

            // The experience a user deserves: still signed in. OpenCode
            // requested exactly the scopes our metadata advertises; whether
            // it got a refresh token decides this assertion — that's the bug.
            const tokens = home.storedTokens(SERVER_NAME);
            expect(
              expired,
              `OpenCode stays signed in across token expiry (its store holds ${
                tokens?.refreshToken ? "a refresh token" : "NO refresh token"
              })`,
            ).toContain("connected");
          },
          {
            cwd: home.projectDir,
            env: { ...home.env, PS1: "$ " },
            record: join(ctx.dir, "terminal.cast"),
            viewport: { cols: 100, rows: 30 },
          },
        )
        .pipe(Effect.ensuring(seedAccessTokenTtl(null)));
    }),
);
