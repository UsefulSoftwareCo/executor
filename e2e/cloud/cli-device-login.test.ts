// Cloud: the CLI `executor login` device-authorization flow end to end against
// the real cloud app, terminal AND browser, both recorded for the viewer. The
// actual `executor` binary runs the OAuth 2.0 Device Authorization Grant
// (RFC 8628) in a real terminal (terminal.cast): it prints the verification URL
// and polls. The browser leg is REAL too (session.mp4): Playwright opens that
// URL, confirms the code, and clicks "Authorize device" on the WorkOS
// emulator's verification page, exactly the human hop, the way the MCP
// approval scenarios drive their browser step. The terminal then runs `whoami`
// and `tools sources`; a clean exit of that chain proves the resulting WorkOS
// access token (a JWT) is accepted by the protected `/api/*` plane.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Cli, RunDir, Target } from "../src/services";
import { enterFocus } from "../src/timeline";
import { CLOUD_BASE_URL } from "../targets/cloud";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "src", "main.ts");

// The WorkOS emulator's compiled dist (@executor-js/emulate) has zero
// references to device_authorization/device_code/verification_uri anywhere —
// it does not implement the OAuth 2.0 Device Authorization Grant (RFC 8628)
// that `executor login`'s device flow depends on (apps/cli/src/device-login.ts
// posts to a `deviceAuthorizationEndpoint` discovered via
// `GET /api/auth/cli-login` and expects `user_code`/`verification_uri[_complete]`
// back). Against the real WorkOS this works; against the emulator the device
// endpoint doesn't exist, so the CLI never prints a `user_code=` URL and both
// scenarios below time out / exit non-zero waiting for it. Real gap in the
// emulator (a separate repo, out of e2e scope here), not a stale test or an
// app regression — suspect: @executor-js/emulate's WorkOS emulator lacking
// RFC 8628 device-authorization support.
const CLI_DEVICE_FLOW_SKIP =
  "the WorkOS emulator doesn't implement RFC 8628 device-authorization (no device_code/verification_uri anywhere in its compiled dist), so `executor login`'s device flow never gets a user_code to print — suspect: @executor-js/emulate's WorkOS emulator";

scenario(
  "CLI · executor login device flow → authenticated /api call",
  { timeout: 180_000, skip: CLI_DEVICE_FLOW_SKIP },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      // Cloud-only: the discovery endpoint + WorkOS device flow are this target's.
      if (target.name !== "cloud") return;

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

      // A fresh signed-in user with an org, the org is what the device token's
      // org_id claim binds to, and what the /api plane authorizes against.
      const identity = yield* target.newIdentity();
      const email = identity.credentials?.email ?? identity.label;

      const env = { ...process.env, EXECUTOR_DATA_DIR: dataDir };
      for (const key of ["EXECUTOR_API_KEY", "EXECUTOR_AUTH_TOKEN", "EXECUTOR_AUTH_PASSWORD"]) {
        delete (env as Record<string, string | undefined>)[key];
      }

      // Hand the printed verification URL from the terminal fiber to the browser.
      let resolveUrl!: (url: string) => void;
      const verificationUrl = new Promise<string>((r) => {
        resolveUrl = r;
      });

      // The terminal journey, recorded to terminal.cast. `&&` means a clean
      // exit only happens if every step, including the authenticated /api call
      // (`tools sources`), succeeded.
      const cli_ = `bun run ${CLI_ENTRY}`;
      const journey =
        `${cli_} login --base-url ${CLOUD_BASE_URL} --no-browser --name cloud && ` +
        `${cli_} whoami --server cloud && ` +
        `${cli_} tools sources --server cloud`;

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

      // The browser leg, a REAL Playwright session approving the device on the
      // verification page (recorded to session.mp4 + per-step screenshots). Runs
      // concurrently with the terminal: it waits for the printed URL, then
      // approves while the CLI is mid-poll.
      const browserApproval = Effect.gen(function* () {
        const url = yield* Effect.promise(() => verificationUrl);
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the device verification link from the terminal", async () => {
            await page.goto(url, { waitUntil: "domcontentloaded" });
            await page
              .getByRole("button", { name: /Authorize device/i })
              .waitFor({ timeout: 15_000 });
          });
          await step("Confirm the code and authorize the device", async () => {
            // The visible email field (existing-user quick buttons also carry a
            // hidden name="email", so target the typed input by type).
            await page.locator('input[type="email"]').fill(email);
            await page.getByRole("button", { name: /Authorize device/i }).click();
            await page.getByText(/Device approved/i).waitFor({ timeout: 15_000 });
          });
        });
        // Cut the synced player back to the terminal for the "Logged in" + the
        // authenticated /api call that follow the browser approval.
        yield* Effect.promise(() => enterFocus(runDir, "terminal"));
      });

      const [finalScreen] = yield* Effect.all([terminal, browserApproval], {
        concurrency: "unbounded",
      });
      expect(finalScreen, "whoami reported the bound organization").toMatch(/org_\w+/);

      // The stored profile carries an oauth device-login credential, not a key.
      const store = JSON.parse(readFileSync(join(dataDir, "server-connections.json"), "utf8")) as {
        defaultProfile: string | null;
        profiles: Array<{
          name: string;
          connection: { auth?: { kind: string; accessToken?: string } };
        }>;
      };
      expect(store.defaultProfile, "the login became the default profile").toBe("cloud");
      const cloudProfile = store.profiles.find((p) => p.name === "cloud");
      expect(cloudProfile?.connection.auth?.kind, "credential is an oauth device token").toBe(
        "oauth",
      );
      expect(typeof cloudProfile?.connection.auth?.accessToken, "an access token is stored").toBe(
        "string",
      );
    }),
  ),
);

// Run `executor login` as a subprocess, approving the device for `approveEmail`
// the moment the verification URL is printed (raw stdout, no PTY).
const runCliLogin = (
  args: readonly string[],
  dataDir: string,
  approveEmail: string,
): Promise<{ code: number | null; stdout: string }> =>
  new Promise((res, rej) => {
    const env = { ...process.env, EXECUTOR_DATA_DIR: dataDir };
    for (const k of ["EXECUTOR_API_KEY", "EXECUTOR_AUTH_TOKEN", "EXECUTOR_AUTH_PASSWORD"]) {
      delete (env as Record<string, string | undefined>)[k];
    }
    const child = spawn("bun", ["run", CLI_ENTRY, ...args], { cwd: REPO_ROOT, env });
    let stdout = "";
    let approved = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (approved) return;
      const match = stdout.match(/(https?:\/\/\S*user_code=\S+)/);
      if (!match) return;
      approved = true;
      const url = new URL(match[1]);
      url.searchParams.set("login_hint", approveEmail);
      void fetch(url, { redirect: "manual" });
    });
    child.stderr.on("data", () => {});
    child.on("error", rej);
    child.on("close", (code) => res({ code, stdout }));
  });

scenario(
  "CLI · two accounts on the same host get separate profiles",
  { timeout: 120_000, skip: CLI_DEVICE_FLOW_SKIP },
  Effect.gen(function* () {
    const target = yield* Target;
    if (target.name !== "cloud") return;

    const runDir = yield* RunDir;
    const dataDir = join(runDir, "multi-home");

    // Two distinct hosted accounts (different user + org) on the SAME server.
    const a = yield* target.newIdentity();
    const b = yield* target.newIdentity();
    const emailA = a.credentials?.email ?? a.label;
    const emailB = b.credentials?.email ?? b.label;

    // Log in as each with NO --name, so naming is driven by the account.
    const loginA = yield* Effect.promise(() =>
      runCliLogin(["login", "--base-url", CLOUD_BASE_URL, "--no-browser"], dataDir, emailA),
    );
    expect(loginA.code, "first login exited cleanly").toBe(0);
    const loginB = yield* Effect.promise(() =>
      runCliLogin(["login", "--base-url", CLOUD_BASE_URL, "--no-browser"], dataDir, emailB),
    );
    expect(loginB.code, "second login exited cleanly").toBe(0);

    const store = JSON.parse(readFileSync(join(dataDir, "server-connections.json"), "utf8")) as {
      defaultProfile: string | null;
      profiles: Array<{
        name: string;
        connection: { origin: string; displayName?: string; auth?: { kind: string } };
      }>;
    };
    const oauthProfiles = store.profiles.filter((p) => p.connection.auth?.kind === "oauth");
    // The second login must NOT clobber the first, both accounts kept.
    expect(oauthProfiles.length, "both accounts retained as separate profiles").toBe(2);
    expect(new Set(oauthProfiles.map((p) => p.name)).size, "profile names are distinct").toBe(2);
    const emails = new Set(oauthProfiles.map((p) => p.connection.displayName));
    expect(emails.has(emailA) && emails.has(emailB), "both account emails present").toBe(true);
  }),
);
