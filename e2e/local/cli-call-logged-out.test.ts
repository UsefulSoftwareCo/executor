// Local CLI: what `executor call` tells a user whose stored hosted-server
// login no longer works. A stub standing in for the hosted server answers
// every request 401 (the wire shape of an expired or revoked session), and
// the default profile carries an expired OAuth token with no way to refresh.
//
// The CLI must treat that 401 as a sign-in problem, not a transport problem:
// name the signed-out profile and the exact `executor login` command, and
// never surface the raw `Decode error (401 GET .../api/tools)` it printed
// before the 401 mapping existed.
//
// The session runs in an interactive shell with an `executor` shim on PATH so
// the terminal.cast reads like the real moment: the user types the command,
// the error is the whole answer.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Cli, RunDir } from "../src/services";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Every route answers like a hosted server rejecting an expired session. */
const listenAsUnauthorizedServer = () =>
  Effect.promise(
    () =>
      new Promise<{ origin: string; close: () => void }>((resolve) => {
        const server = createServer((_request, response) => {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "unauthorized" }));
        });
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as AddressInfo;
          resolve({
            origin: `http://127.0.0.1:${port}`,
            close: () => server.close(),
          });
        });
      }),
  );

/** A data dir whose default profile is a hosted server with an expired,
 *  unrefreshable OAuth token: the state `executor server list` shows as
 *  `stored-auth` after a login has gone stale. The `profile:` key matches
 *  what `executor login` persists via upsertCliServerConnectionProfile. */
const writeLoggedOutProfile = (dataDir: string, origin: string) => {
  writeFileSync(
    join(dataDir, "server-connections.json"),
    JSON.stringify(
      {
        version: 1,
        defaultProfile: "hosted",
        profiles: [
          {
            name: "hosted",
            connection: {
              kind: "http",
              key: "profile:hosted",
              origin,
              displayName: "hosted",
              auth: { kind: "oauth", accessToken: "expired-access-token", expiresAt: 1 },
            },
          },
        ],
      },
      null,
      2,
    ),
  );
};

/** An `executor` on PATH that runs this checkout's CLI, so the recording
 *  shows the command a user actually types. */
const writeExecutorShim = (binDir: string) => {
  const shim = join(binDir, "executor");
  writeFileSync(shim, `#!/bin/sh\nexec bun run "${join(repoRoot, "apps/cli/src/main.ts")}" "$@"\n`);
  chmodSync(shim, 0o755);
};

scenario(
  "CLI call · a signed-out hosted profile explains how to log back in",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const runDir = yield* RunDir;

    const hosted = yield* listenAsUnauthorizedServer();
    const dataDir = mkdtempSync(join(tmpdir(), "executor-cli-logged-out-"));
    writeLoggedOutProfile(dataDir, hosted.origin);
    writeExecutorShim(dataDir);

    yield* cli
      .session(
        ["bash", "--noprofile", "--norc"],
        async (term) => {
          await term.screen.waitUntil((current) => current.text.includes("$"), {
            timeoutMs: 30_000,
          });

          // The user browses the catalog the way the docs teach: call --help.
          await term.keyboard.type("executor call github issues --help", { paceMs: 40 });
          await term.keyboard.press("Enter");

          // The command exits after printing its sign-in error.
          const snapshot = await term.screen.waitUntil((current) => current.text.includes("401"), {
            timeoutMs: 60_000,
          });
          const screen = snapshot.text;

          // The moment reads as a sign-in problem, scoped to the profile...
          expect(screen, "the error says the user is signed out").toContain("You're signed out");
          expect(screen, "it names the stale profile").toContain('profile "hosted"');
          // ...and hands over the exact recovery command (in dev mode the
          // prefix is `bun run .../main.ts`, so assert the stable suffix).
          expect(screen, "it prints the login command for that profile").toContain(
            "login --server hosted",
          );

          // The pre-fix rendering must not resurface.
          expect(screen, "the raw transport error stays internal").not.toContain("Decode error");
          expect(screen, "the API endpoint does not leak into the message").not.toContain(
            "/api/tools",
          );
        },
        {
          cwd: repoRoot,
          env: {
            EXECUTOR_DATA_DIR: dataDir,
            EXECUTOR_SCOPE_DIR: dataDir,
            PATH: `${dataDir}${delimiter}${process.env.PATH ?? ""}`,
            PS1: "$ ",
            // Keep macOS's "default shell is now zsh" banner out of the cast.
            BASH_SILENCE_DEPRECATION_WARNING: "1",
          },
          record: join(runDir, "terminal.cast"),
          viewport: { cols: 100, rows: 24 },
        },
      )
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            hosted.close();
            rmSync(dataDir, { recursive: true, force: true });
          }),
        ),
      );
  }),
);
