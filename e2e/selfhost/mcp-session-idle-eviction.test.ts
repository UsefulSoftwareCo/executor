// Selfhost-only: an MCP session that goes idle past the store's TTL is
// reclaimed, and the next request on that session id gets the 404 / -32001 cue
// that tells a client to re-initialize.
//
// Why this scenario boots its OWN instance instead of using the shared one:
// the idle window is a BOOT-TIME operator knob
// (EXECUTOR_MCP_SESSION_IDLE_TTL_MS), so there is no way to shrink it on a
// running server. Waiting out the 30-minute default is not an option, and
// shrinking it on the SHARED instance would silently evict sessions underneath
// every other selfhost scenario. A dedicated instance on its own port and data
// dir keeps the short window contained to this file.
//
// Why the wait is a single silent sleep rather than a poll loop: every request
// the store forwards restamps that session's last-seen time. A poll loop is
// itself the traffic that keeps the session alive, so it could never observe an
// eviction. The scenario stays completely silent for one window, then makes
// exactly one request.
//
// Auth is the Better Auth session cookie, not an OAuth bearer: self-host's MCP
// auth provider accepts the cookie/api-key identity path, and the credential is
// not what is under test here — session lifetime is.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { RunDir, Target } from "../src/services";
import { claimAndBoot } from "../src/ports";
import { isBootReadinessTimeout } from "../setup/boot";
import { bootSelfhost } from "../setup/selfhost.boot";
import { SELFHOST_ADMIN, signInSession } from "../targets/selfhost";

/** The idle window this instance runs with — small enough that the sweep, not
 *  the TTL, sets the pace. */
const IDLE_TTL_MS = 2_000;

/**
 * How long to leave the session untouched. The store floors its sweep interval
 * at 30s, so an idle session is disposed at the first tick that falls at least
 * one TTL after its last request. Waiting two full sweep intervals plus the TTL
 * means the assertion can never race a tick that has not fired yet.
 */
const QUIET_WINDOW_MS = 2 * 30_000 + IDLE_TTL_MS + 5_000;

interface JsonRpcErrorBody {
  readonly error?: { readonly code?: number; readonly message?: string };
}

scenario(
  "MCP · an idle self-host session is evicted and answers 404 -32001 until the client re-initializes",
  // Own vite dev boot (cold on a fresh checkout) plus a 67s quiet window, so
  // this needs materially more than the project's 180s default.
  { timeout: 420_000 },
  Effect.gen(function* () {
    // Selfhost-shaped scenario: yielded for the target name in failures, and so
    // the file reads like its neighbours.
    yield* Target;
    const runDir = yield* RunDir;

    const dataDir = mkdtempSync(join(tmpdir(), "executor-selfhost-idle-ttl-"));

    // A distinct env var (not E2E_SELFHOST_PORT, which the shared instance has
    // already published into this worker's env) so the claim actually probes
    // and locks a free port instead of returning the shared one.
    const booted = yield* Effect.promise(() =>
      claimAndBoot(
        [{ envVar: "E2E_SELFHOST_IDLE_TTL_PORT", offset: 6, label: "selfhost idle-ttl vite dev" }],
        async (ports) => {
          const port = ports.E2E_SELFHOST_IDLE_TTL_PORT!;
          const baseUrl = `http://localhost:${port}`;
          const procs = await bootSelfhost({
            port,
            webBaseUrl: baseUrl,
            admin: SELFHOST_ADMIN,
            dataDir,
            logFile: join(runDir, "idle-ttl-boot.log"),
            mcpSessionIdleTtlMs: IDLE_TTL_MS,
          });
          return { teardown: procs.teardown, value: baseUrl };
        },
        { label: "selfhost idle-ttl", retryWhen: isBootReadinessTimeout },
      ),
    );

    yield* Effect.gen(function* () {
      const baseUrl = booted.value;
      const mcpUrl = new URL("/mcp", baseUrl).toString();
      const { cookieHeader } = yield* Effect.promise(() => signInSession(baseUrl, SELFHOST_ADMIN));

      const initialize = async (): Promise<Response> =>
        fetch(mcpUrl, {
          method: "POST",
          headers: {
            cookie: cookieHeader,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "idle-ttl-e2e", version: "1" },
            },
          }),
        });

      const listTools = async (sessionId: string, id: number): Promise<Response> =>
        fetch(mcpUrl, {
          method: "POST",
          headers: {
            cookie: cookieHeader,
            "mcp-session-id": sessionId,
            "mcp-protocol-version": "2025-06-18",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" }),
        });

      // 1. A client initializes and the session serves.
      const opened = yield* Effect.promise(initialize);
      expect(opened.status, "initialize succeeds").toBe(200);
      const sessionId = opened.headers.get("mcp-session-id");
      expect(sessionId, "initialize returns a session id").toEqual(expect.any(String));

      const working = yield* Effect.promise(() => listTools(sessionId!, 2));
      expect(working.status, "the fresh session serves a request").toBe(200);

      // 2. Idleness, driven by the clock and nothing else. Touching the session
      //    here — even to poll — would restamp it and defeat the measurement.
      yield* Effect.sleep(`${QUIET_WINDOW_MS} millis`);

      // 3. The evicted id is gone, and says so in the shape a client acts on:
      //    404 tells it the id is dead, -32001 is the session-lifecycle code.
      const afterIdle = yield* Effect.promise(() => listTools(sessionId!, 3));
      const afterIdleBody = yield* Effect.promise(() => afterIdle.text());
      // A session that was NOT evicted answers with the whole tool catalog, so
      // the diagnostic is truncated — the status is the assertion, and a full
      // tools/list dump in the failure output helps nobody.
      expect(
        afterIdle.status,
        `an idle session is evicted, so its id 404s; body starts: ${afterIdleBody.slice(0, 200)}`,
      ).toBe(404);
      // oxlint-disable-next-line executor/no-json-parse -- boundary: the raw JSON-RPC error frame this scenario asserts on, never decoded into a domain type
      const parsed = JSON.parse(afterIdleBody) as JsonRpcErrorBody;
      expect(parsed.error?.code, "the 404 carries the session-lifecycle code").toBe(-32001);

      // 4. The cue is actionable: re-initializing gets a NEW, working session.
      const reopened = yield* Effect.promise(initialize);
      expect(reopened.status, "the client can re-initialize after eviction").toBe(200);
      const newSessionId = reopened.headers.get("mcp-session-id");
      expect(newSessionId, "re-initialize returns a session id").toEqual(expect.any(String));
      expect(newSessionId, "re-initialize issues a different session").not.toBe(sessionId);

      const afterReinit = yield* Effect.promise(() => listTools(newSessionId!, 4));
      expect(afterReinit.status, "the re-initialized session serves a request").toBe(200);
    }).pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          await booted.teardown();
          rmSync(dataDir, { recursive: true, force: true });
        }),
      ),
    );
  }),
);
