// Cloud: the CLI `executor login` device-authorization flow end to end against
// the real cloud app, driven in a REAL terminal (recorded to terminal.cast for
// the viewer). A fresh user+org is minted through the product login, then the
// actual `executor` binary runs the OAuth 2.0 Device Authorization Grant
// (RFC 8628) against the WorkOS emulator the cloud advertises: it asks for a
// device code, prints the verification URL, and polls. The "browser" leg is
// completed headlessly — the test approves the device as this user via the
// emulator's login_hint path, exactly like the MCP OAuth scenarios drive
// mcpConsent. The session then runs `whoami` and `tools sources`; a clean exit
// of that chain proves the resulting WorkOS access token (a JWT) is accepted by
// the protected `/api/*` plane.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Cli, RunDir, Target } from "../src/services";
import { CLOUD_BASE_URL } from "../targets/cloud";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "src", "main.ts");

scenario(
  "CLI · executor login device flow → authenticated /api call",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    // Cloud-only: the discovery endpoint + WorkOS device flow are this target's.
    if (target.name !== "cloud") return;

    const cli = yield* Cli;
    const runDir = yield* RunDir;
    const dataDir = join(runDir, "cli-home");

    // A fresh signed-in user with an org — the org is what the device token's
    // org_id claim binds to, and what the /api plane authorizes against.
    const identity = yield* target.newIdentity();
    const email = identity.credentials?.email ?? identity.label;

    const env = { ...process.env, EXECUTOR_DATA_DIR: dataDir };
    for (const key of ["EXECUTOR_API_KEY", "EXECUTOR_AUTH_TOKEN", "EXECUTOR_AUTH_PASSWORD"]) {
      delete (env as Record<string, string | undefined>)[key];
    }

    // One terminal session, recorded: log in (approving the device when the
    // verification URL appears), then prove the stored token works by reading
    // identity back and making a real /api call. `&&` means a clean exit only
    // happens if every step — including the authenticated /api call — succeeded.
    const cli_ = `bun run ${CLI_ENTRY}`;
    const journey =
      `${cli_} login --base-url ${CLOUD_BASE_URL} --no-browser --name cloud && ` +
      `${cli_} whoami --server cloud && ` +
      `${cli_} tools sources --server cloud`;

    const finalScreen = yield* cli.session(
      ["bash", "-c", journey],
      async (session) => {
        // The CLI prints the verification URL; approve it in the "browser".
        await session.screen.waitForText(/user_code=/, { timeoutMs: 45_000 });
        const screen = await session.screen.text();
        const match = screen.match(/(https?:\/\/\S*user_code=\S+)/);
        if (!match) throw new Error(`verification URL not found on screen:\n${screen}`);
        const verificationUrl = new URL(match[1]);
        verificationUrl.searchParams.set("login_hint", email);
        const approve = await fetch(verificationUrl, { redirect: "manual" });
        if (approve.status >= 400) {
          throw new Error(`device approval failed (${approve.status})`);
        }
        await session.screen.waitForText("Logged in to", { timeoutMs: 45_000 });
        const exit = await session.waitForExit({ timeoutMs: 45_000 });
        if (exit.reason !== "exited" || exit.exit.code !== 0) {
          throw new Error(`journey did not exit cleanly: ${JSON.stringify(exit)}`);
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

    // whoami read the org back out of the stored token (WorkOS access tokens
    // carry sub + org_id, not email).
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
  { timeout: 120_000 },
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
    // The second login must NOT clobber the first — both accounts kept.
    expect(oauthProfiles.length, "both accounts retained as separate profiles").toBe(2);
    expect(new Set(oauthProfiles.map((p) => p.name)).size, "profile names are distinct").toBe(2);
    const emails = new Set(oauthProfiles.map((p) => p.connection.displayName));
    expect(emails.has(emailA) && emails.has(emailB), "both account emails present").toBe(true);
  }),
);
