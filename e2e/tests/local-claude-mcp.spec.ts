/** The real client registers, pairs consent through the local dashboard and invokes a tool. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { ClaudeClient } from "../support/claude-client.ts";
import { McpConsent } from "../support/mcp-consent.ts";
import { deployLocalMcpApp } from "../support/mcp-app.ts";
import { Evidence } from "../support/evidence.ts";

layer(TestLive, { excludeTestServices: true })("Claude Code Local MCP", (it) => {
  it.effect(scenarios.localMcp.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const claude = yield* ClaudeClient,
          consent = yield* McpConsent,
          evidence = yield* Evidence;
        const fixture = yield* evidence.step("Prepare a callable synthetic app", deployLocalMcpApp);
        const client = yield* claude.start;
        const request = yield* client.requestConnection;
        yield* consent.approve(request);
        yield* client.finishConnection;
        const result = yield* client.invoke(fixture.name, fixture.receipt);
        expect(result).toContain(fixture.receipt);
        expect(result).toContain("from Claude Code");
      }).pipe(Effect.provide(Layer.mergeAll(ClaudeClient.layer, McpConsent.localLayer))),
    ),
  );
});
