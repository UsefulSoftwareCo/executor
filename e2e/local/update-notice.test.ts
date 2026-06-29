// Local-only: the "a newer Executor is published" nudge, on BOTH surfaces a
// user meets it. A forced dist-tags signal (`EXECUTOR_NPM_DIST_TAGS`) stands in
// for the npm registry so the check is deterministic and offline:
//
//   1. CLI: `executor web --foreground` prints an "Update available" line
//             under its ready banner (recorded as terminal.cast).
//   2. Web: the same server's `/v1/app/npm/dist-tags` lights up the shell's
//             sidebar UpdateCard (captured as a step screenshot).
//
// Both read the one resolver in `@executor-js/api` (update-check.ts), so the
// terminal line and the sidebar card can never disagree about the verdict.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Cli, RunDir, Target } from "../src/services";
import { withLocalServer } from "./local-server";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// A version far above anything we'd really publish, so the running build is
// unambiguously "behind" regardless of the actual package version.
const FORCED_LATEST = "99.0.0";
const DIST_TAGS = JSON.stringify({ latest: FORCED_LATEST, beta: `${FORCED_LATEST}-beta.1` });

scenario(
  "Local update · the CLI ready banner nudges to upgrade when a newer version is published",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const runDir = yield* RunDir;
    const dataDir = mkdtempSync(join(tmpdir(), "executor-update-cli-"));

    yield* cli
      .session(
        ["bun", "run", "apps/cli/src/main.ts", "web", "--foreground", "--port", "0"],
        async (term) => {
          // The notice prints right under the "Executor is ready." banner, just
          // before "Press Ctrl+C to stop.": wait for that line so we know the
          // whole banner (notice included) has rendered.
          const snapshot = await term.screen.waitUntil(
            (current) => current.text.includes("Press Ctrl+C to stop"),
            { timeoutMs: 120_000 },
          );
          const screen = snapshot.text;
          expect(screen, "the banner announces an available update").toContain("Update available");
          expect(screen, "it names the published version").toContain(FORCED_LATEST);
          expect(screen, "it prints the upgrade command").toContain("npm i -g executor@latest");
          // Graceful shutdown so the PTY closes instead of leaking the server.
          await term.keyboard.press("Control+C");
        },
        {
          cwd: repoRoot,
          env: {
            EXECUTOR_DATA_DIR: dataDir,
            EXECUTOR_SCOPE_DIR: dataDir,
            EXECUTOR_NPM_DIST_TAGS: DIST_TAGS,
          },
          record: join(runDir, "terminal.cast"),
          viewport: { cols: 120, rows: 40 },
        },
      )
      .pipe(Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))));
  }),
);

scenario(
  "Local update · the web shell sidebar surfaces the update-available card",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const browser = yield* Browser;
    const target = yield* Target;
    const runDir = yield* RunDir;
    const identity = yield* target.newIdentity();

    yield* withLocalServer(
      cli,
      runDir,
      ({ url }) =>
        browser.session(identity, async ({ page, step }) => {
          await step("Open the console via the CLI's ?_token URL", async () => {
            await page.goto(url, { waitUntil: "domcontentloaded" });
            // The console renders past the auth gate: the Integrations page and
            // its built-in Executor source row load (proves auth + data, not
            // just the static shell).
            await page.getByRole("heading", { name: "Integrations" }).waitFor({ timeout: 60_000 });
            await page.getByText("Tool providers available").waitFor({ timeout: 30_000 });
          });

          await step("The sidebar surfaces the update-available card", async () => {
            // The card renders once useLatestVersion resolves the forced
            // dist-tags served by /v1/app/npm/dist-tags.
            await page.getByText("Update available").waitFor({ timeout: 30_000 });
            await page.getByText(`v${FORCED_LATEST}`).waitFor({ timeout: 5_000 });
            await page
              .getByText("npm i -g executor@latest", { exact: true })
              .first()
              .waitFor({ timeout: 5_000 });
          });
        }),
      { env: { EXECUTOR_NPM_DIST_TAGS: DIST_TAGS } },
    );
  }),
);

scenario(
  "Local update · the desktop bridge shows a native restart-to-update card, not the npm command",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const browser = yield* Browser;
    const target = yield* Target;
    const runDir = yield* RunDir;
    const identity = yield* target.newIdentity();

    // Drives the SAME shell the Electron renderer loads, with a stand-in for the
    // desktop preload bridge (window.executor). A real packaged Electron run is
    // covered by e2e/desktop/update-card.test.ts; this proves the renderer half
    // (native card shown, npm command suppressed) in the browser harness.
    yield* withLocalServer(cli, runDir, ({ url }) =>
      browser.session(identity, async ({ page, step }) => {
        await page.addInitScript((version: string) => {
          let status = { state: "downloaded", version };
          const subscribers: Array<(next: typeof status) => void> = [];
          Object.assign(window, {
            executor: {
              getUpdateStatus: () => Promise.resolve(status),
              onUpdateStatus: (cb: (next: typeof status) => void) => {
                subscribers.push(cb);
                return () => {};
              },
              installUpdate: () => {
                status = { state: "installing", version };
                for (const cb of subscribers) cb(status);
                return Promise.resolve();
              },
            },
          });
        }, FORCED_LATEST);

        await step("Open the desktop console", async () => {
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page.getByRole("heading", { name: "Integrations" }).waitFor({ timeout: 60_000 });
          await page.getByText("Tool providers available").waitFor({ timeout: 30_000 });
        });

        await step("The sidebar shows a native Restart to update card", async () => {
          await page.getByText("Update available").waitFor({ timeout: 30_000 });
          await page.getByText(`v${FORCED_LATEST}`).waitFor({ timeout: 5_000 });
          await page.getByRole("button", { name: "Restart to update" }).waitFor({ timeout: 5_000 });
          // The desktop card never shows the npm command the web/CLI card does.
          expect(
            await page.getByText("npm i -g", { exact: false }).count(),
            "the desktop card shows no npm command",
          ).toBe(0);
        });

        await step("Clicking Restart drives the native install action", async () => {
          await page.getByRole("button", { name: "Restart to update" }).click();
          await page.getByText("Restarting…").waitFor({ timeout: 5_000 });
        });
      }),
    );
  }),
);
