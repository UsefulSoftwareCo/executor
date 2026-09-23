/** The real client opens OAuth from /mcp and invokes a tool in that same authenticated session. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { ClaudeClient } from "../support/claude-client.ts";
import { McpConsent } from "../support/mcp-consent.ts";
import { deployMcpApp } from "../support/mcp-app.ts";
import { Evidence } from "../support/evidence.ts";

layer(HostedLive, { excludeTestServices: true })("Claude Code MCP", (it) => {
  it.effect(scenarios.mcp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const claude = yield* ClaudeClient,
          consent = yield* McpConsent,
          evidence = yield* Evidence;
        const fixture = yield* evidence.step("Prepare a callable synthetic app", deployMcpApp);
        const client = yield* claude.start;
        const request = yield* client.requestConnection;
        yield* consent.approve(request);
        yield* client.finishConnection;
        const result = yield* client.invoke(fixture.name, fixture.receipt);
        expect(result).toContain(fixture.receipt);
        expect(result).toContain("from Claude Code");
      }).pipe(Effect.provide(Layer.mergeAll(ClaudeClient.layer, McpConsent.layer))),
    ),
  );
});
