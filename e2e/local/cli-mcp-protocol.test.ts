// Regression for #1449: a modern MCP client starts stdio negotiation with
// `server/discover`, before `initialize`. This crosses the real CLI bridge:
//
//   v2/v1 stdio client -> `executor mcp` -> local daemon HTTP MCP endpoint
//
// It reconnects with the v1 SDK too, proving discovery forwarding does not
// regress established legacy stdio clients.
import { expect } from "@effect/vitest";
import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { scenario } from "../src/scenario";
import { stopAutoSpawnedDaemon } from "./daemon-process";

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

const withTempData = Effect.acquireRelease(
  Effect.sync(() => {
    const root = mkdtempSync(join(tmpdir(), "executor-mcp-protocol-"));
    return { root, dataDir: join(root, "data") };
  }),
  ({ root, dataDir }) =>
    Effect.promise(async () => {
      await stopAutoSpawnedDaemon(dataDir);
      rmSync(root, { recursive: true, force: true });
    }),
);

scenario(
  "Local CLI MCP · modern discovery and legacy initialize cross the stdio bridge",
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
        expect(modernClient.getProtocolEra()).toBe("modern");
        expect((await modernClient.listTools()).tools.map(({ name }) => name)).toContain("execute");
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
        expect((await legacyClient.listTools()).tools.map(({ name }) => name)).toContain("execute");
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
