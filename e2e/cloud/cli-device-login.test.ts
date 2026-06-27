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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

scenario(
  "CLI · executor login device flow → authenticated /api call",
  { timeout: 180_000 },
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
      // This directory contains live OAuth credentials. Keep it outside the
      // viewer-served runs tree and remove it when the scenario finishes.
      const dataDir = mkdtempSync(join(tmpdir(), "executor-e2e-cli-cloud-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dataDir, { recursive: true, force: true })),
      );

      // A fresh signed-in user with an org, the org is what the device token's
      // org_id claim binds to, and what the /api plane authorizes against.
      const identity = yield* target.newIdentity();
      const email = identity.credentials?.email ?? identity.label;

      const env: Record<string, string> = {
        ...process.env,
        EXECUTOR_DATA_DIR: dataDir,
      };
      delete env.EXECUTOR_API_KEY;
      delete env.EXECUTOR_AUTH_TOKEN;
      delete env.EXECUTOR_AUTH_PASSWORD;

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
        `${cli_} tools sources --server cloud && ` +
        `${cli_} server list`;

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
      expect(finalScreen, "the public profile list reports stored authentication").toMatch(
        /\* cloud\s+http\s+\S+\s+\S+\s+stored-auth/,
      );
    }),
  ),
);

const cliEnvironment = (dataDir: string) => {
  const env: Record<string, string> = {
    ...process.env,
    EXECUTOR_DATA_DIR: dataDir,
  };
  delete env.EXECUTOR_API_KEY;
  delete env.EXECUTOR_AUTH_TOKEN;
  delete env.EXECUTOR_AUTH_PASSWORD;
  return env;
};

const runCli = (args: readonly string[], dataDir: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((res, rej) => {
    const child = spawn("bun", ["run", CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
      env: cliEnvironment(dataDir),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", rej);
    child.on("close", (code) => res({ code, stdout, stderr }));
  });

// Run `executor login` as a subprocess, approving the device for `approveEmail`
// the moment the verification URL is printed (raw stdout, no PTY).
const runCliLogin = (args: readonly string[], dataDir: string, approveEmail: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((res, rej) => {
    const child = spawn("bun", ["run", CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
      env: cliEnvironment(dataDir),
    });
    let stdout = "";
    let stderr = "";
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
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", rej);
    child.on("close", (code) => res({ code, stdout, stderr }));
  });

const profileNameFromLogin = (stdout: string) => {
  const profileName = stdout.match(/profile "([^"]+)"/)?.[1];
  if (!profileName) throw new Error(`login output did not contain a profile name:\n${stdout}`);
  return profileName;
};

scenario(
  "CLI · switch, logout, and re-login two accounts on one host",
  { timeout: 120_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      if (target.name !== "cloud") return;

      const dataDir = mkdtempSync(join(tmpdir(), "executor-e2e-cli-cloud-accounts-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dataDir, { recursive: true, force: true })),
      );

      // Two distinct hosted accounts (different user + org) on the same server.
      const a = yield* target.newIdentity();
      const b = yield* target.newIdentity();
      const emailA = a.credentials?.email ?? a.label;
      const emailB = b.credentials?.email ?? b.label;

      // Log in as each with no pinned name, so naming is driven by account identity.
      const loginA = yield* Effect.promise(() =>
        runCliLogin(["login", "--base-url", CLOUD_BASE_URL, "--no-browser"], dataDir, emailA),
      );
      expect(loginA.code, `first login failed:\n${loginA.stderr}`).toBe(0);
      const profileA = profileNameFromLogin(loginA.stdout);

      const loginB = yield* Effect.promise(() =>
        runCliLogin(["login", "--base-url", CLOUD_BASE_URL, "--no-browser"], dataDir, emailB),
      );
      expect(loginB.code, `second login failed:\n${loginB.stderr}`).toBe(0);
      const profileB = profileNameFromLogin(loginB.stdout);
      expect(profileB, "the second account has a distinct profile").not.toBe(profileA);

      const useA = yield* Effect.promise(() => runCli(["server", "use", profileA], dataDir));
      expect(useA.code, `selecting account A failed:\n${useA.stderr}`).toBe(0);
      const callA = yield* Effect.promise(() => runCli(["tools", "sources"], dataDir));
      expect(callA.code, `account A protected call failed:\n${callA.stderr}`).toBe(0);

      const useB = yield* Effect.promise(() => runCli(["server", "use", profileB], dataDir));
      expect(useB.code, `selecting account B failed:\n${useB.stderr}`).toBe(0);
      const callB = yield* Effect.promise(() => runCli(["tools", "sources"], dataDir));
      expect(callB.code, `account B protected call failed:\n${callB.stderr}`).toBe(0);

      const ambiguousLogout = yield* Effect.promise(() =>
        runCli(["logout", "--base-url", CLOUD_BASE_URL], dataDir),
      );
      expect(ambiguousLogout.code, "origin-only logout rejects ambiguous accounts").not.toBe(0);
      expect(`${ambiguousLogout.stdout}\n${ambiguousLogout.stderr}`).toContain(
        "Multiple server profiles",
      );

      const logoutB = yield* Effect.promise(() =>
        runCli(["logout", "--server", profileB], dataDir),
      );
      expect(logoutB.code, `named logout failed:\n${logoutB.stderr}`).toBe(0);
      const loggedOutB = yield* Effect.promise(() =>
        runCli(["whoami", "--server", profileB], dataDir),
      );
      expect(loggedOutB.stdout).toContain("Not logged in (no stored credentials).");

      yield* Effect.promise(() => runCli(["server", "use", profileA], dataDir));
      const stillAuthenticatedA = yield* Effect.promise(() =>
        runCli(["tools", "sources"], dataDir),
      );
      expect(
        stillAuthenticatedA.code,
        `account A was affected by logging out B:\n${stillAuthenticatedA.stderr}`,
      ).toBe(0);

      const reloginB = yield* Effect.promise(() =>
        runCliLogin(["login", "--base-url", CLOUD_BASE_URL, "--no-browser"], dataDir, emailB),
      );
      expect(reloginB.code, `account B re-login failed:\n${reloginB.stderr}`).toBe(0);
      expect(profileNameFromLogin(reloginB.stdout), "re-login reused B's profile").toBe(profileB);

      const useReloggedB = yield* Effect.promise(() =>
        runCli(["server", "use", profileB], dataDir),
      );
      expect(useReloggedB.code, `reselecting account B failed:\n${useReloggedB.stderr}`).toBe(0);
      const reloggedCallB = yield* Effect.promise(() => runCli(["tools", "sources"], dataDir));
      expect(reloggedCallB.code, `re-logged account B call failed:\n${reloggedCallB.stderr}`).toBe(
        0,
      );

      const listed = yield* Effect.promise(() => runCli(["server", "list"], dataDir));
      expect(listed.code, `listing profiles failed:\n${listed.stderr}`).toBe(0);
      expect(listed.stdout).toContain(profileA);
      expect(listed.stdout).toContain(profileB);
      expect(listed.stdout.match(/stored-auth/g), "both profiles retain credentials").toHaveLength(
        2,
      );
    }),
  ),
);
