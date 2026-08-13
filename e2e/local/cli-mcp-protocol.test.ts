// Regression for #1449: a modern MCP client starts stdio negotiation with
// `server/discover`, before `initialize`. This test crosses the real CLI bridge:
//
//   v1/v2 stdio client -> `executor mcp` -> local daemon HTTP MCP endpoint
//
// It also reconnects with the v1 SDK so forwarding the modern discovery
// envelope cannot regress existing stdio clients.
import { expect } from "@effect/vitest";
import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Effect } from "effect";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { scenario } from "../src/scenario";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const testScope = join(repoRoot, "apps/local");

const bridgeCommand = (dataDir: string) => ({
  command: "bun",
  args: ["run", "dev:cli", "mcp", "--scope", testScope],
  cwd: repoRoot,
  env: {
    ...process.env,
    EXECUTOR_DATA_DIR: dataDir,
    EXECUTOR_DISABLE_INTEGRATIONS_FETCH: "1",
  } as Record<string, string>,
  stderr: "pipe" as const,
});

const stopAutoSpawnedDaemon = (dataDir: string): void => {
  // `executor mcp` owns only the bridge. Its local daemon is deliberately
  // detached, so stop that owner before deleting this test's private data dir.
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: cleanup tolerates a bridge that failed before writing its manifest
  try {
    const manifest = JSON.parse(
      readFileSync(join(dataDir, "server-control", "server.json"), "utf8"),
    ) as { readonly pid?: number };
    if (manifest.pid) process.kill(manifest.pid, "SIGTERM");
  } catch {
    // No manifest means there is no auto-spawned daemon to stop.
  }
};

const withTempData = Effect.acquireRelease(
  Effect.sync(() => {
    const root = mkdtempSync(join(tmpdir(), "executor-mcp-protocol-"));
    return { root, dataDir: join(root, "data") };
  }),
  ({ root, dataDir }) =>
    Effect.sync(() => {
      stopAutoSpawnedDaemon(dataDir);
      rmSync(root, { recursive: true, force: true });
    }),
);

scenario(
  "Local CLI MCP · modern discovery and legacy initialize both cross the stdio bridge",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const { dataDir } = yield* withTempData;

    const modernTransport = new ModernStdioClientTransport(bridgeCommand(dataDir));
    const modernClient = new ModernClient(
      { name: "executor-cli-modern-e2e", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );

    yield* Effect.promise(async () => {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: always reap the real CLI child when an assertion fails
      try {
        await modernClient.connect(modernTransport);
        // Auto negotiation can report "modern" only after `server/discover`
        // succeeds before any legacy `initialize` fallback.
        expect(modernClient.getProtocolEra()).toBe("modern");
        const listed = await modernClient.listTools();
        expect(listed.tools.map(({ name }) => name)).toEqual(["execute", "skills"]);
        const executed = await modernClient.callTool({
          name: "execute",
          arguments: { code: "return 42" },
        });
        expect(executed.structuredContent).toMatchObject({
          status: "completed",
          result: 42,
        });
      } finally {
        await modernClient.close();
      }
    });

    const legacyTransport = new LegacyStdioClientTransport(bridgeCommand(dataDir));
    const legacyClient = new LegacyClient({
      name: "executor-cli-legacy-e2e",
      version: "1.0.0",
    });

    yield* Effect.promise(async () => {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: always reap the real CLI child when an assertion fails
      try {
        await legacyClient.connect(legacyTransport);
        const listed = await legacyClient.listTools();
        // Legacy clients retain the established, broader tool surface. The two
        // cross-era tools must remain available without requiring exact parity
        // with the modern server's progressively disclosed list.
        expect(listed.tools.map(({ name }) => name)).toEqual(
          expect.arrayContaining(["execute", "skills"]),
        );
        const executed = await legacyClient.callTool({
          name: "execute",
          arguments: { code: "return 42" },
        });
        expect(executed.structuredContent).toMatchObject({
          status: "completed",
          result: 42,
        });
      } finally {
        await legacyClient.close();
      }
    });
  }).pipe(Effect.scoped),
);
