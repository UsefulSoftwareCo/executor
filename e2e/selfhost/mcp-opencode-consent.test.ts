// The REAL OpenCode binary connecting to a self-host instance over MCP OAuth,
// through the actual human approval screen — and recorded as ONE spliced video
// (agent terminal → browser consent → agent terminal).
//
// Nothing about the client is modeled: OpenCode runs its own discovery against
// the published metadata, its own dynamic client registration, PKCE, scope
// request, and token store. The only "theater" is that the browser hop OpenCode
// would normally open is captured by an open(1) shim (clients/opencode.ts) and
// driven by a real Playwright browser here — which navigates the authorize URL,
// lands on the forced /mcp-consent approval screen, and clicks Allow. The
// consent redirect goes to OpenCode's own localhost callback, so OpenCode
// receives the code and finishes the grant for real.
//
// The PTY (terminal.cast) and the browser (session.mp4) run concurrently and
// mark focus as they act, so scripts/film.ts cuts them into one film.mp4: the
// agent asks → we approve in the browser → the agent is connected.
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { enterFocus, markRecordingStart } from "../src/timeline";
import { Browser, Cli, Mcp, OpenCode, RunDir, Target } from "../src/services";

const SERVER_NAME = "executor";

scenario(
  "MCP OAuth · the real OpenCode binary connects to self-host through the approval screen",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const opencode = yield* OpenCode;
    const browser = yield* Browser;
    const cli = yield* Cli;
    const runDir = yield* RunDir;

    // The signed-in instance owner — the browser context gets these cookies, so
    // OpenCode's authorize URL lands straight on the consent screen (no login).
    const identity = yield* target.newIdentity();
    const home = opencode.makeHome(SERVER_NAME, mcp.url);
    // First-run DB migration off camera so the recorded session starts clean.
    yield* Effect.sync(() => opencode.warmUp(home));
    // Read THIS flow's authorize URL, not a stale one.
    const sinceIndex = home.openedUrls().length;

    // Wait for OpenCode to "open the browser" (the shim records the URL).
    const waitForAuthorizeUrl = async (): Promise<string> => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const url = home.openedUrls()[sinceIndex];
        if (url) return url.trim();
        await new Promise((tick) => setTimeout(tick, 250));
      }
      throw new Error("opencode never opened an authorization URL");
    };

    // The agent and the browser run concurrently: `opencode mcp auth` blocks on
    // its localhost callback, which only fires once the browser completes the
    // consent redirect. Effect.all interrupts the other side if either fails.
    yield* Effect.all(
      [
        // ── Terminal: drive the real OpenCode binary ─────────────────────────
        cli.session(
          ["bash", "--norc"],
          async (term) => {
            markRecordingStart(runDir, "terminal");
            await enterFocus(runDir, "terminal");
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

            // Blocks until the browser fiber completes consent → OpenCode's
            // callback receives the code → OpenCode stores the grant.
            const auth = await sh(`opencode mcp auth ${SERVER_NAME}`, 120_000);
            // Tab back to the terminal (the framework lingers on the browser
            // first when filming).
            await enterFocus(runDir, "terminal");
            expect(auth, "opencode mcp auth completes").not.toContain("failed");

            const list = await sh("opencode mcp list", 60_000);
            expect(list, "OpenCode connects after the approved grant").toContain("connected");

            // The grant is real: OpenCode persisted an access token for the server.
            const tokens = home.storedTokens(SERVER_NAME);
            expect(tokens?.accessToken, "OpenCode stored an access token").toBeTruthy();
          },
          {
            cwd: home.projectDir,
            env: { ...home.env, PS1: "$ ", BASH_SILENCE_DEPRECATION_WARNING: "1" },
            record: join(runDir, "terminal.cast"),
            viewport: { cols: 100, rows: 40 },
          },
        ),

        // ── Browser: approve the connection on the real consent screen ───────
        browser.session(identity, async ({ page, step }) => {
          const authorizeUrl = await waitForAuthorizeUrl();
          const appHost = new URL(target.baseUrl).host;
          // Two named steps: each is a thing the developer pauses to look at, so
          // the framework's per-step beat holds the consent screen, then the
          // result — no hand-rolled timeouts. (The first step's enterFocus also
          // lingers on the terminal mid-OAuth before tabbing here.)
          await step("OpenCode asks to connect — the approval screen", async () => {
            // Authenticated (owner cookies) → authorize forces prompt=consent →
            // the approval screen.
            await page.goto(authorizeUrl, { waitUntil: "networkidle" });
            await page.locator("#mcp-consent-allow").waitFor({ timeout: 30_000 });
            expect(new URL(page.url()).pathname, "lands on the approval screen").toBe(
              "/mcp-consent",
            );
          });
          await step("Approve — back to OpenCode with a code", async () => {
            await page.locator("#mcp-consent-allow").click();
            // Approval redirects out of the app to OpenCode's own localhost
            // callback (a different host) — that delivery unblocks the PTY.
            await page.waitForURL((url) => url.host !== appHost, { timeout: 30_000 });
          });
        }),
      ],
      { concurrency: "unbounded" },
    );
  }),
);
