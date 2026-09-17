// ---------------------------------------------------------------------------
// A liveness probe must not conclude "this connection is broken" from a
// failure its OWN second connection caused.
//
// `checkHealth` dials through `discoverToolsFromInput`, which builds a FRESH
// connector (`plugin.ts` → `discover.ts` → `createMcpConnector`) rather than
// taking the pooled connection tool invocations use (`connection-pool.ts`,
// one idle session per identity, five-minute TTL). For a remote server that
// costs a handshake. For a local stdio server it spawns a SECOND CHILD PROCESS
// — and the common local servers are single-instance: Chrome DevTools MCP owns
// a browser and a debug port, Playwright MCP the same, `docker run -i` a
// container. A second concurrent process cannot start and exits non-zero.
//
// So the probe's verdict describes the probe, not the connection: the server is
// up, it is serving the pooled client, every tool call works — and the accounts
// list says the connection is broken. The next probe (which the UI forces on
// every mount for any non-healthy verdict, `use-connection-health.ts`) runs once
// the pooled child is gone and reports healthy again. That is the
// "disconnected, then connected" flap.
//
// Two tests: the first documents current behavior and passes on main; the
// second asserts what the probe ought to answer, fails on main, and is checked
// in skipped as the fix's acceptance anchor.
//
// `it.live`: this measures real child processes, so it needs the wall clock.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { mcpPlugin } from "./plugin";

const fixture = fileURLToPath(new URL("./stdio-single-instance-test-server.ts", import.meta.url));

type Verdict = { readonly status: string; readonly detail?: string; readonly reason?: string };

const checkHealth = (config: unknown): Effect.Effect<Verdict> =>
  Effect.gen(function* () {
    const plugin = mcpPlugin({ dangerouslyAllowStdioMCP: true });
    const seam = (plugin as { readonly checkHealth?: unknown }).checkHealth;
    if (typeof seam !== "function") {
      return yield* Effect.die("mcpPlugin no longer exposes checkHealth");
    }
    return yield* (
      seam as (input: {
        readonly ctx: { readonly httpClientLayer: typeof FetchHttpClient.layer };
        readonly credential: {
          readonly config: unknown;
          readonly values: Record<string, string | null>;
          readonly template: string | null;
          readonly connection: string;
          readonly integration: string;
        };
      }) => Effect.Effect<Verdict>
    )({
      ctx: { httpClientLayer: FetchHttpClient.layer },
      credential: {
        config,
        values: {},
        template: null,
        connection: "main",
        integration: "single_instance_mcp",
      },
    });
  });

const waitUntil = (predicate: () => boolean, timeoutMs: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) return false;
      yield* Effect.sleep(Duration.millis(50));
    }
    return true;
  });

const spawnedPids = (log: string): readonly number[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => Number(line))
    : [];

describe("MCP liveness probe against a single-instance local stdio server", () => {
  it.live(
    "documents current behavior: the probe spawns a second child and reports the live server broken",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "mcp-single-instance-"));
        const lockFile = join(dir, "lock");
        const spawnLog = join(dir, "spawns");
        const config = {
          transport: "stdio" as const,
          command: "bun",
          args: ["run", fixture, lockFile, spawnLog],
        };

        // The instance a tool invocation would be holding: the pool keeps at most
        // one idle connection per identity for five minutes, so during that window
        // the server is up and serving.
        let pooled: ChildProcess | undefined;
        yield* Effect.acquireUseRelease(
          Effect.gen(function* () {
            pooled = spawn("bun", ["run", fixture, lockFile, spawnLog], {
              stdio: ["pipe", "pipe", "pipe"],
            });
            // Keep stdin open: the fixture exits when stdin ends, which is the
            // same contract a pooled MCP child has.
            pooled.stdin?.on("error", () => {});
            return yield* waitUntil(() => existsSync(lockFile), 20_000);
          }),
          (started) =>
            Effect.gen(function* () {
              expect(started, "the pooled instance took the lock").toBe(true);
              expect(spawnedPids(spawnLog), "one child so far").toHaveLength(1);

              const before = spawnedPids(spawnLog).length;
              const verdict = yield* checkHealth(config);
              const after = spawnedPids(spawnLog);

              // The probe did not reuse anything: it started another process.
              expect(after.length, "the health probe spawned its own child").toBe(before + 1);
              // The server is alive and holding the lock the whole time.
              expect(existsSync(lockFile), "the pooled server is still running").toBe(true);

              // … and the verdict says the connection is broken, because the
              // probe's OWN second instance could not start.
              expect(verdict.status, "a live, serving server is reported unhealthy").not.toBe(
                "healthy",
              );
              return verdict;
            }),
          () =>
            Effect.sync(() => {
              pooled?.stdin?.end();
              pooled?.kill("SIGTERM");
            }),
        );
        void pooled;
      }),
  );

  // Skipped, not deleted: this is the acceptance anchor for the R8 fix in
  // plans/oauth-refresh-and-expired-status.md (Phase 3). The PR that lands the
  // fix un-skips it and it must go green unchanged.
  it.live.skip(
    "REPRO: a probe must not report the connection broken for its own second spawn",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "mcp-single-instance-"));
        const lockFile = join(dir, "lock");
        const spawnLog = join(dir, "spawns");
        const config = {
          transport: "stdio" as const,
          command: "bun",
          args: ["run", fixture, lockFile, spawnLog],
        };
        let pooled: ChildProcess | undefined;
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            pooled = spawn("bun", ["run", fixture, lockFile, spawnLog], {
              stdio: ["pipe", "pipe", "pipe"],
            });
            pooled.stdin?.on("error", () => {});
          }),
          () =>
            Effect.gen(function* () {
              expect(yield* waitUntil(() => existsSync(lockFile), 20_000)).toBe(true);
              const verdict = yield* checkHealth(config);
              // Phase 3/5 target: either answer from the live pooled connection,
              // or classify "another instance of this server is already running"
              // as the non-alarm it is. What it must not do is tell the user this
              // credential/connection is broken.
              expect(verdict.status, "a server that is up and serving reads healthy").toBe(
                "healthy",
              );
            }),
          () =>
            Effect.sync(() => {
              pooled?.stdin?.end();
              pooled?.kill("SIGTERM");
            }),
        );
      }),
  );
});
