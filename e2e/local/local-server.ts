// Shared helper for the `local` e2e project: boot a real temporary server with
// `executor web --foreground` in a recorded terminal, parse its printed one-time
// `?_token=` URL, and run a body against it. Each scenario boots its OWN server
// (own throwaway data dir, `--port 0`) so files can run in parallel without
// colliding. The terminal stays up until the body settles, then Ctrl-C gives a
// graceful shutdown (so the vite child dies and the PTY closes).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import type { CliSurface } from "../src/surfaces/cli";
import { markFocus, markRecordingStart } from "../src/timeline";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** The `Open: …/?_token=<token>` URL the CLI prints once the server is up. */
export const TOKEN_URL = /http:\/\/127\.0\.0\.1:\d+\/\?_token=[A-Za-z0-9_-]+/;

export interface ServerHandle {
  /** The full `?_token=` bootstrap URL (origin + token). */
  readonly url: string;
  /** The server origin, e.g. `http://127.0.0.1:54321`. */
  readonly origin: string;
  /** The bearer token (the `_token` query param), in plaintext. */
  readonly token: string;
}

/**
 * Boot `executor web --foreground` and run `body` against the resulting
 * {@link ServerHandle}. Keeps the server up until the body settles, then Ctrl-C
 * for a graceful shutdown. Cleans up the throwaway data dir. The body may drive
 * the browser, a typed API client, an MCP client — anything that needs the live
 * server.
 */
export const withLocalServer = (
  cli: CliSurface,
  runDir: string,
  body: (server: ServerHandle) => Effect.Effect<void>,
  options?: {
    /** Extra env merged into the `executor web` process, e.g. to force a
     *  published-version signal for the update check. */
    readonly env?: Record<string, string>;
  },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const dataDir = mkdtempSync(join(tmpdir(), "executor-local-e2e-"));

    let publishUrl!: (url: string) => void;
    const urlReady = new Promise<string>((res) => {
      publishUrl = res;
    });
    let signalBodyDone!: () => void;
    const bodyDone = new Promise<void>((res) => {
      signalBodyDone = res;
    });

    yield* Effect.all(
      [
        cli.session(
          ["bun", "run", "dev:cli", "web", "--foreground", "--port", "0"],
          async (term) => {
            markRecordingStart(runDir, "terminal");
            markFocus(runDir, "terminal");
            // Capture the latest rendered screen on every poll so a boot that
            // never prints the URL is still diagnosable: `waitUntil` rejects
            // with a tail-less "timed out" on its deadline, so without this the
            // failure tells us nothing about how far boot actually got.
            let lastText = "";
            const snapshot = await term.screen
              .waitUntil(
                (current) => {
                  lastText = current.text;
                  return TOKEN_URL.test(current.text);
                },
                // A cold `executor web` runs vite's optimizeDeps before it prints
                // the URL; 180s is generous headroom over the warm ~3s boot. Kept
                // BELOW each scenario's test timeout (240s) so that on a slow or
                // wedged boot THIS error surfaces, with the terminal tail, rather
                // than racing vitest's generic timeout at the same deadline.
                { timeoutMs: 180_000 },
              )
              .catch((cause: unknown) => {
                throw new Error(
                  `executor web --foreground printed no ?_token URL within 180s (${String(cause)}):\n${lastText.slice(-600)}`,
                );
              });
            const url = TOKEN_URL.exec(snapshot.text)?.[0];
            if (!url) {
              throw new Error(
                `executor web --foreground printed no ?_token URL:\n${snapshot.text.slice(-600)}`,
              );
            }
            publishUrl(url);
            await bodyDone;
            // Graceful shutdown so the vite child is killed and the PTY closes;
            // otherwise the orphaned child wedges the terminal teardown.
            markFocus(runDir, "terminal");
            await term.keyboard.press("Control+C");
          },
          {
            cwd: repoRoot,
            env: { EXECUTOR_DATA_DIR: dataDir, EXECUTOR_SCOPE_DIR: dataDir, ...options?.env },
            record: join(runDir, "terminal.cast"),
            viewport: { cols: 120, rows: 40 },
          },
        ),

        Effect.gen(function* () {
          const url = yield* Effect.promise(() => urlReady);
          const parsed = new URL(url);
          yield* body({
            url,
            origin: parsed.origin,
            token: parsed.searchParams.get("_token")!,
          }).pipe(Effect.ensuring(Effect.sync(() => signalBodyDone())));
        }),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))));
  });
