// Self-host: the CLI `executor login` device-authorization flow end to end
// against the self-host app (Better Auth), terminal AND browser, both recorded.
// The `executor` binary runs RFC 8628 in a real terminal (terminal.cast): it
// discovers Better Auth's device endpoints via /api/auth/cli-login, prints the
// verification URL, and polls. The browser leg is REAL (session.mp4): Playwright
// opens the self-host /device page (signed in via the session cookie) and clicks
// "Authorize device". The terminal then runs `whoami` and `tools sources`; a
// clean exit of that chain proves the Better Auth device token is accepted as a
// Bearer on the protected /api/* plane.
import { readFileSync } from "node:fs";
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
      const dataDir = join(runDir, "cli-home");

      // A signed-in identity (its session cookie authorizes the /device page).
      const identity = yield* target.newIdentity();

      const env = { ...process.env, EXECUTOR_DATA_DIR: dataDir };
      for (const key of ["EXECUTOR_API_KEY", "EXECUTOR_AUTH_TOKEN", "EXECUTOR_AUTH_PASSWORD"]) {
        delete (env as Record<string, string | undefined>)[key];
      }

      let resolveUrl!: (url: string) => void;
      const verificationUrl = new Promise<string>((r) => {
        resolveUrl = r;
      });

      const cli_ = `bun run ${CLI_ENTRY}`;
      const journey =
        `${cli_} login --base-url ${SELFHOST_BASE_URL} --no-browser --name selfhost && ` +
        `${cli_} whoami --server selfhost && ` +
        `${cli_} tools sources --server selfhost`;

      const terminal = cli.session(
        ["bash", "-c", journey],
        async (session) => {
          await session.screen.waitForText(/user_code=/, { timeoutMs: 60_000 });
          const match = (await session.screen.text()).match(/(https?:\/\/\S*user_code=\S+)/);
          if (!match) throw new Error("verification URL not found on screen");
          resolveUrl(match[1]);
          await session.screen.waitForText("Logged in to", { timeoutMs: 60_000 });
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
        const url = yield* Effect.promise(() => verificationUrl);
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the device verification page", async () => {
            await page.goto(url, { waitUntil: "domcontentloaded" });
            // The Authorize button appears once the page binds the signed-in user.
            await page
              .getByRole("button", { name: /Authorize device/i })
              .waitFor({ timeout: 20_000 });
          });
          await step("Authorize the device", async () => {
            await page.getByRole("button", { name: /Authorize device/i }).click();
            await page.getByText(/Device approved/i).waitFor({ timeout: 15_000 });
          });
        });
        // Cut the synced player back to the terminal for the "Logged in" + the
        // authenticated /api call that follow the browser approval.
        yield* Effect.promise(() => enterFocus(runDir, "terminal"));
      });

      // Reaching here means the whole `&&` chain exited 0, including the
      // authenticated `tools sources` /api call.
      yield* Effect.all([terminal, browserApproval], { concurrency: "unbounded" });

      // The stored profile carries an oauth device-login credential, not a key.
      const store = JSON.parse(readFileSync(join(dataDir, "server-connections.json"), "utf8")) as {
        defaultProfile: string | null;
        profiles: Array<{
          name: string;
          connection: { auth?: { kind: string; accessToken?: string } };
        }>;
      };
      expect(store.defaultProfile, "the login became the default profile").toBe("selfhost");
      const profile = store.profiles.find((p) => p.name === "selfhost");
      expect(profile?.connection.auth?.kind, "credential is an oauth device token").toBe("oauth");
      expect(typeof profile?.connection.auth?.accessToken, "an access token is stored").toBe(
        "string",
      );
    }),
  ),
);
