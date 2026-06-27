// Self-host: the CLI `executor login` device-authorization flow end to end
// against the self-host app (Better Auth), terminal AND browser, both recorded.
// The `executor` binary runs RFC 8628 in a real terminal (terminal.cast): it
// discovers Better Auth's device endpoints via /api/auth/cli-login, prints the
// verification URL, and polls. The browser leg is REAL (session.mp4): Playwright
// opens the self-host /device page (signed in via the session cookie) and clicks
// "Authorize device". The terminal then runs `whoami` and `tools sources`; a
// clean exit of that chain proves the Better Auth device token is accepted as a
// Bearer on the protected /api/* plane.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Cli, RunDir, Target } from "../src/services";
import { enterFocus } from "../src/timeline";
import { SELFHOST_BASE_URL } from "../targets/selfhost";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "src", "main.ts");

scenario(
  "CLI · executor login device flow → authenticated /api call",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      if (target.name !== "selfhost") return;

      // Slow + hold the browser steps so the recording is watchable. Scoped to
      // this scenario and restored after (files run serially, so a leaked flag
      // would slow every later scenario).
      const prevFilm = process.env.E2E_FILM;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (prevFilm === undefined) delete process.env.E2E_FILM;
          else process.env.E2E_FILM = prevFilm;
        }),
      );
      process.env.E2E_FILM = "1";

      const cli = yield* Cli;
      const browser = yield* Browser;
      const runDir = yield* RunDir;
      // This directory contains live OAuth credentials. Keep it outside the
      // viewer-served runs tree and remove it when the scenario finishes.
      const dataDir = mkdtempSync(join(tmpdir(), "executor-e2e-cli-selfhost-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dataDir, { recursive: true, force: true })),
      );

      // A signed-in identity (its session cookie authorizes the /device page).
      const identity = yield* target.newIdentity();

      const env: Record<string, string> = {
        ...process.env,
        EXECUTOR_DATA_DIR: dataDir,
      };
      delete env.EXECUTOR_API_KEY;
      delete env.EXECUTOR_AUTH_TOKEN;
      delete env.EXECUTOR_AUTH_PASSWORD;

      let resolveFirstUrl!: (url: string) => void;
      const firstVerificationUrl = new Promise<string>((resolveUrl) => {
        resolveFirstUrl = resolveUrl;
      });
      let resolveSecondUrl!: (url: string) => void;
      const secondVerificationUrl = new Promise<string>((resolveUrl) => {
        resolveSecondUrl = resolveUrl;
      });

      const cli_ = `bun run ${CLI_ENTRY}`;
      const journey =
        `${cli_} login --base-url ${SELFHOST_BASE_URL} --no-browser --name selfhost && ` +
        `${cli_} whoami --server selfhost && ` +
        `${cli_} tools sources --server selfhost && ` +
        `${cli_} logout --server selfhost && ` +
        `${cli_} whoami --server selfhost && ` +
        `echo SECOND_LOGIN_START && ` +
        `${cli_} login --base-url ${SELFHOST_BASE_URL} --no-browser && ` +
        `${cli_} tools sources --server selfhost && ` +
        `${cli_} server list`;

      const terminal = cli.session(
        ["bash", "-c", journey],
        async (session) => {
          await session.screen.waitForText(/user_code=/, { timeoutMs: 60_000 });
          const match = (await session.screen.text()).match(/(https?:\/\/\S*user_code=\S+)/);
          if (!match) throw new Error("verification URL not found on screen");
          resolveFirstUrl(match[1]);
          await session.screen.waitForText("Logged in to", { timeoutMs: 60_000 });

          const secondLogin = await session.screen.waitUntil(
            (current) => {
              const marker = current.text.lastIndexOf("SECOND_LOGIN_START");
              return marker >= 0 && /https?:\/\/\S*user_code=\S+/.test(current.text.slice(marker));
            },
            { timeoutMs: 60_000 },
          );
          const marker = secondLogin.text.lastIndexOf("SECOND_LOGIN_START");
          const secondMatch = secondLogin.text.slice(marker).match(/(https?:\/\/\S*user_code=\S+)/);
          if (!secondMatch) throw new Error("second verification URL not found on screen");
          resolveSecondUrl(secondMatch[1]);

          const exit = await session.waitForExit({ timeoutMs: 60_000 });
          if (exit.reason !== "exited" || exit.exit.code !== 0) {
            throw new Error(
              `journey did not exit cleanly: ${JSON.stringify(exit)}\n${await session.screen.text()}`,
            );
          }
          return session.screen.text();
        },
        {
          cwd: REPO_ROOT,
          env,
          record: join(runDir, "terminal.cast"),
          viewport: { cols: 300, rows: 48 },
        },
      );

      // The browser leg, approve on the self-host /device page (session cookie
      // from the identity authorizes it). Recorded to session.mp4.
      const browserApproval = Effect.gen(function* () {
        const firstUrl = yield* Effect.promise(() => firstVerificationUrl);
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the first device verification page", async () => {
            await page.goto(firstUrl, { waitUntil: "domcontentloaded" });
            // The Authorize button appears once the page binds the signed-in user.
            await page
              .getByRole("button", { name: /Authorize device/i })
              .waitFor({ timeout: 20_000 });
          });
          await step("Authorize the first login", async () => {
            await page.getByRole("button", { name: /Authorize device/i }).click();
            await page.getByText(/Device approved/i).waitFor({ timeout: 15_000 });
          });
          const secondUrl = await secondVerificationUrl;
          await step("Open the re-login device verification page", async () => {
            await page.goto(secondUrl, { waitUntil: "domcontentloaded" });
            await page
              .getByRole("button", { name: /Authorize device/i })
              .waitFor({ timeout: 20_000 });
          });
          await step("Authorize the re-login", async () => {
            await page.getByRole("button", { name: /Authorize device/i }).click();
            await page.getByText(/Device approved/i).waitFor({ timeout: 15_000 });
          });
        });
        // Cut the synced player back to the terminal for the "Logged in" + the
        // authenticated /api call that follow the browser approval.
        yield* Effect.promise(() => enterFocus(runDir, "terminal"));
      });

      // Reaching here means the whole chain exited 0, including protected calls
      // before logout and after re-login.
      const [finalScreen] = yield* Effect.all([terminal, browserApproval], {
        concurrency: "unbounded",
      });
      expect(finalScreen, "named logout cleared the selected local credential").toContain(
        "Not logged in (no stored credentials).",
      );
      expect(finalScreen, "re-login reused the named profile").toMatch(
        /Logged in to \S+ \(profile "selfhost", now the default\)\./,
      );
      expect(finalScreen, "the public profile list reports restored authentication").toMatch(
        /\* selfhost\s+http\s+\S+\s+\S+\s+stored-auth/,
      );
    }),
  ),
);
