/** A full MCP soak probe runs on an isolated organization in the dedicated CI job. */
import { layer } from "@effect/vitest";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { mcpMemoryProbe } from "../support/mcp-memory-scenario.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("MCP memory", (it) => {
  // Temporarily skipped: deployed streams end unexpectedly; the transport cause is unresolved.
  // Evidence: https://github.com/UsefulSoftwareCo/executor-next/actions/runs/36063767428
  it.effect.skip(
    scenarios.mcpMemoryShared.title,
    (context) =>
      withHostedCase(
        context,
        mcpMemoryProbe({
          title: scenarios.mcpMemoryShared.title,
          hosts: 1,
          perHost: 128,
          rounds: 256,
          reconnectStreams: 1,
          concurrency: 4,
          beforeSeconds: 180,
          afterSeconds: 180,
        }),
      ),
    { timeout: 1_200_000 },
  );
});
