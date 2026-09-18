// A liveness probe must reuse the invocation pool's connection instead of
// dialling a second one. For a stdio server a fresh dial starts a second child
// process, and the common local servers permit one instance only (Chrome
// DevTools MCP, Playwright MCP, `docker run -i`): the second child cannot
// start, so the probe reported a live, serving server as broken — once per page
// mount, because the UI re-probes every non-healthy verdict.
//
// The fixture refuses to start while a live process holds its lock, so two
// probes pass only when the second reuses the first one's child.
//
// `it.live`: this measures real child processes, so it needs the wall clock.

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { mcpPlugin } from "./plugin";

const fixture = fileURLToPath(new URL("./stdio-single-instance-test-server.ts", import.meta.url));

type Verdict = { readonly status: string; readonly detail?: string; readonly reason?: string };

type CheckHealth = (input: {
  readonly ctx: { readonly httpClientLayer: typeof FetchHttpClient.layer };
  readonly credential: {
    readonly config: unknown;
    readonly values: Record<string, string | null>;
    readonly template: string | null;
    readonly owner: string;
    readonly connection: string;
    readonly integration: string;
  };
}) => Effect.Effect<Verdict>;

/** One plugin instance, so both probes share its connection pool — the same
 *  lifetime the pool has in a host. */
const pluginCheckHealth = (): CheckHealth => {
  const plugin = mcpPlugin({ dangerouslyAllowStdioMCP: true });
  const seam = (plugin as { readonly checkHealth?: CheckHealth }).checkHealth;
  // The seam is part of the plugin contract. A build without it cannot run this
  // scenario at all, so die rather than invent a verdict.
  return seam ?? ((() => Effect.die("mcpPlugin no longer exposes checkHealth")) as CheckHealth);
};

const spawnedPids = (log: string): readonly number[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => Number(line))
    : [];

/** Stop every child the fixture logged. The pool keeps an idle child alive by
 *  design, and a test must not leave one behind. */
const stopSpawned = (log: string): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const pid of spawnedPids(log)) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: kill throws ESRCH when the child already exited, which is the desired state
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  });

describe("MCP liveness probe against a single-instance local stdio server", () => {
  it.live("reuses the pooled child, so a second probe starts no second process", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "mcp-single-instance-"));
      const lockFile = join(dir, "lock");
      const spawnLog = join(dir, "spawns");
      const config = {
        transport: "stdio" as const,
        command: "bun",
        args: ["run", fixture, lockFile, spawnLog],
      };
      const checkHealth = pluginCheckHealth();
      const credential = {
        config,
        values: {},
        template: null,
        owner: "user",
        connection: "main",
        integration: "single_instance_mcp",
      };
      const ctx = { httpClientLayer: FetchHttpClient.layer };

      yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen(function* () {
            const first = yield* checkHealth({ ctx, credential });
            expect(first.status, "the first probe dials and the server answers").toBe("healthy");
            expect(spawnedPids(spawnLog), "and it started exactly one child").toHaveLength(1);

            // The pooled child is alive and still holds the lock, so a second
            // dial could not start. This probe passes only by reuse.
            expect(existsSync(lockFile), "the first child is still running").toBe(true);
            const second = yield* checkHealth({ ctx, credential });
            expect(second.status, "the second probe reads the same live server").toBe("healthy");
            expect(spawnedPids(spawnLog), "and it started no second child").toHaveLength(1);
          }),
        () => stopSpawned(spawnLog),
      );
    }),
  );
});
