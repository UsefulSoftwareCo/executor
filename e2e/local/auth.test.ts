// Local-only — the single-user bearer-auth flow as DEVELOPER SESSIONS, the way
// a human tests it: run the dev CLI in a real terminal, watch
// `executor web --foreground` print its one-time `?_token=` URL, then drive a
// browser against it. Two clean stories, each its own film (terminal.cast +
// session.mp4 spliced by scenario.ts), each booting its OWN temporary server
// (own data dir, `--port 0`):
//
//   1. The CLI's ?_token URL boots straight into an authenticated console.
//   2. Opening the app WITHOUT the token shows the LocalAuthGate; pasting the
//      token connects.
//
// `withLocalServer` (shared helper) runs `executor web --foreground` in a
// recorded terminal and hands the printed URL to a body; the terminal stays up
// until the body is done, then Ctrl-C shuts it (and its vite child) down so the
// PTY closes.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Cli, RunDir, Target } from "../src/services";
import { withLocalServer } from "./local-server";

scenario(
  "Local auth · the CLI's ?_token URL boots an authenticated console",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const browser = yield* Browser;
    const target = yield* Target;
    const runDir = yield* RunDir;
    const identity = yield* target.newIdentity();

    yield* withLocalServer(cli, runDir, ({ url, token }) =>
      browser.session(identity, async ({ page, step }) => {
        await step("Open the ?_token URL printed by executor web --foreground", async () => {
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page.getByRole("link", { name: "Secrets" }).first().waitFor({ timeout: 30_000 });
          // Integrations actually LOAD (the built-in Executor source) — proves
          // auth + data, not just the static shell.
          await page.getByText("built-in").first().waitFor({ timeout: 30_000 });
          // The token is moved out of the URL and persisted to localStorage.
          expect(new URL(page.url()).searchParams.has("_token")).toBe(false);
          const stored = await page.evaluate(() => localStorage.getItem("executor.authToken"));
          expect(stored).toBe(token);
        });
      }),
    );
  }),
);

scenario(
  "Local auth · opening the app without the token shows the gate; pasting it connects",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const browser = yield* Browser;
    const target = yield* Target;
    const runDir = yield* RunDir;
    const identity = yield* target.newIdentity();

    yield* withLocalServer(cli, runDir, ({ origin, token }) =>
      browser.session(identity, async ({ page, step }) => {
        await step("Open the app with no token — the login gate appears", async () => {
          await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
          await page.getByText("Authentication required").waitFor({ timeout: 30_000 });
        });

        await step("Paste the token (the one in auth.json) and connect", async () => {
          await page.getByPlaceholder("Bearer token").fill(token);
          await page.getByRole("button", { name: "Connect" }).click();
          await page.getByRole("link", { name: "Secrets" }).first().waitFor({ timeout: 30_000 });
          // The reconnect fully restores — integrations LOAD, not a stale 401.
          await page.getByText("built-in").first().waitFor({ timeout: 30_000 });
        });
      }),
    );
  }),
);
