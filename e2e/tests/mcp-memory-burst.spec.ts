/** A full MCP soak probe runs on an isolated organization in the dedicated CI job. */
import { layer } from "@effect/vitest";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { mcpMemoryProbe } from "../support/mcp-memory-scenario.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("MCP memory", (it) => {
  it.effect(
    scenarios.mcpMemoryBurst.title,
    (context) =>
      withHostedCase(
        context,
        mcpMemoryProbe({
          title: scenarios.mcpMemoryBurst.title,
          hosts: 1,
          perHost: 4,
          rounds: 128,
          reconnectStreams: 16,
          concurrency: 16,
          beforeSeconds: 30,
          afterSeconds: 180,
        }),
      ),
    { timeout: 1_200_000 },
  );
});
