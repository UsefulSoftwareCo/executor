// The toolkit-connect performance bug, reproduced with the REAL opencode
// binary in a REAL terminal. A user adds a dozen sources to their workspace,
// makes a toolkit, and points OpenCode at /mcp/toolkits/<slug>. OpenCode runs
// its own OAuth (discovery, DCR, PKCE) and then `mcp list`. The whole session
// runs in one recorded PTY: the run's terminal.cast replays exactly what a
// user at a shell sees.
//
// Before the fix, building the toolkit session walks the WHOLE catalog with a
// per-tool policy resolution (an N+1 that scales with total tools, not toolkit
// size), so `mcp list` blows past OpenCode's connect timeout and the server
// shows "failed". After the fix the walk is two batched reads and the same
// command shows "connected". The catalog is seeded over the public API exactly
// as a user would build it.
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Api, Cli, OpenCode, RunDir, Target } from "../src/services";
import { catalogApi, seedLargeCatalog } from "../scenarios/support/large-catalog";

const SERVER_NAME = "executor";

scenario(
  "Toolkits · the real OpenCode binary connects to a toolkit over a large catalog",
  { timeout: 240_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const opencode = yield* OpenCode;
      const runDir = yield* RunDir;
      const cli = yield* Cli;
      const { client: makeClient } = yield* Api;

      const identity = yield* target.newIdentity();
      const email = identity.credentials?.email ?? identity.label;
      const client = yield* makeClient(catalogApi, identity);

      // Build a production-shaped workspace: one real spec + ten more sources,
      // a toolkit scoped to one of them. ~3,300 tools across 11 sources — large
      // enough that the pre-fix per-tool policy N+1 pushes the toolkit connect
      // past OpenCode's client timeout.
      const seeded = yield* seedLargeCatalog(client);

      yield* Effect.gen(function* () {
        const toolkitUrl = new URL(
          `/mcp/toolkits/${seeded.toolkitSlug}`,
          target.baseUrl,
        ).toString();
        const home = opencode.makeHome(SERVER_NAME, toolkitUrl);
        // First-run database migration happens off camera.
        yield* Effect.sync(() => opencode.warmUp(home));

        yield* cli.session(
          ["bash", "--norc"],
          async (term) => {
            await term.screen.waitForText("$", { timeoutMs: 10_000 });

            const outputAfter = (text: string, line: string): string | null => {
              const echoed = text.lastIndexOf(line);
              if (echoed === -1) return null;
              const after = text.slice(echoed + line.length);
              return after.trimEnd().endsWith("\n$") ? after : null;
            };
            const sh = async (line: string, timeoutMs: number) => {
              await term.keyboard.type(line);
              await term.keyboard.press("Enter");
              const snapshot = await term.screen.waitUntil(
                (current) => outputAfter(current.text, line) !== null,
                { timeoutMs },
              );
              return outputAfter(snapshot.text, line) ?? "";
            };

            // OpenCode completes MCP OAuth for real: discovery, DCR, PKCE, its
            // own scope request, its own token store.
            const consent = opencode.completeOAuthConsent(home, email, home.openedUrls().length);
            const auth = await sh(`opencode mcp auth ${SERVER_NAME}`, 90_000);
            await consent;
            expect(auth, "opencode mcp auth completes").not.toContain("failed");

            // The load-bearing line: listing the toolkit server forces OpenCode
            // to establish the session, which builds the execute-tool
            // description over the whole catalog. Pre-fix this is where the
            // per-tool N+1 times the client out; post-fix it returns promptly.
            const listed = await sh("opencode mcp list", 120_000);
            expect(
              listed,
              "OpenCode connects to the toolkit even with a large catalog behind it",
            ).toContain("connected");
          },
          {
            cwd: home.projectDir,
            env: { ...home.env, PS1: "$ ", BASH_SILENCE_DEPRECATION_WARNING: "1" },
            record: join(runDir, "terminal.cast"),
            viewport: { cols: 100, rows: 40 },
          },
        );
      }).pipe(Effect.ensuring(seeded.cleanup));
    }),
  ),
);
