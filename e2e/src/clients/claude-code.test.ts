import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeEchoMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";

import { serveAnthropicReplayBrain } from "./anthropic-replay-brain";
import {
  hasClaudeCode,
  isClaudeCodeRequired,
  makeClaudeCodeHome,
  readClaudeCodeMcpConfig,
  removeClaudeCodeHome,
  replaceClaudeCodeServer,
  runClaudeCode,
} from "./claude-code";

const scopedClaudeHome = (
  serverName: string,
  server: { readonly url: string; readonly authorizationHeader?: string },
) =>
  Effect.acquireRelease(
    Effect.sync(() => makeClaudeCodeHome(serverName, server)),
    (home) => Effect.sync(() => removeClaudeCodeHome(home)),
  );

const scriptedEchoBrain = () =>
  serveAnthropicReplayBrain((context) =>
    context.lastToolResult
      ? { text: `finished:${context.lastToolResult}` }
      : { tool: { name: "echo", input: { value: "account-switch" } } },
  );

it.effect("isolates Claude state and replaces one server name without retaining credentials", () =>
  Effect.gen(function* () {
    const home = yield* scopedClaudeHome("executor", {
      url: "http://127.0.0.1:41001/mcp",
      authorizationHeader: "Bearer first-account-secret",
    });

    expect(home.rootDir).not.toContain("/e2e/runs/");
    expect(home.homeDir).not.toBe(process.env.HOME);
    expect(home.configDir).toBe(home.env.CLAUDE_CONFIG_DIR);
    expect(home.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(home.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(home.env).not.toHaveProperty("HTTP_PROXY");
    expect(home.env).not.toHaveProperty("HTTPS_PROXY");

    yield* replaceClaudeCodeServer(
      home,
      {
        url: "http://127.0.0.1:41002/mcp",
        authorizationHeader: "Bearer second-account-secret",
      },
      { clearOAuthCredentials: false },
    );
    const config = JSON.stringify(readClaudeCodeMcpConfig(home));
    expect(config).toContain("http://127.0.0.1:41002/mcp");
    expect(config).toContain("second-account-secret");
    expect(config).not.toContain("http://127.0.0.1:41001/mcp");
    expect(config).not.toContain("first-account-secret");
  }),
);

const claudeAvailable = hasClaudeCode();

it.effect.skipIf(!claudeAvailable && !isClaudeCodeRequired())(
  "the real Claude Code binary discovers, invokes, and replaces an MCP account",
  () =>
    Effect.gen(function* () {
      expect(
        claudeAvailable,
        "Claude Code is required but its pinned native binary is unavailable",
      ).toBe(true);

      const firstServer = yield* serveMcpServer(() =>
        makeEchoMcpServer({ text: (value) => `account-a:${value}` }),
      );
      const secondServer = yield* serveMcpServer(() =>
        makeEchoMcpServer({ text: (value) => `account-b:${value}` }),
      );
      const home = yield* scopedClaudeHome("executor", { url: firstServer.url });

      const firstBrain = yield* scriptedEchoBrain();
      const first = yield* runClaudeCode(home, {
        brainBaseUrl: firstBrain.baseUrl,
        prompt: "Call the configured echo tool once.",
      });
      expect(first.result).toContain("account-a:account-switch");
      expect(first.claudeCodeVersion).toBe("2.1.195");
      // Claude reports a catalog-price estimate even when every model request
      // terminates at the loopback replay server. The driver's loopback-only
      // URL gate, fake API key, and captured requests are the no-inference proof.
      expect(firstBrain.requests().length).toBeGreaterThan(0);
      expect(
        firstBrain.requests().some((request) => request.toolNames.includes("mcp__executor__echo")),
      ).toBe(true);
      expect(firstBrain.errors()).toEqual([]);

      yield* replaceClaudeCodeServer(home, { url: secondServer.url });

      const secondBrain = yield* scriptedEchoBrain();
      const second = yield* runClaudeCode(home, {
        brainBaseUrl: secondBrain.baseUrl,
        prompt: "Call the configured echo tool once after the account switch.",
      });
      expect(second.result).toContain("account-b:account-switch");
      expect(second.result).not.toContain("account-a:account-switch");
      expect(secondBrain.errors()).toEqual([]);

      const firstRequests = yield* firstServer.requests;
      const secondRequests = yield* secondServer.requests;
      expect(firstRequests.some((request) => request.method === "POST")).toBe(true);
      expect(secondRequests.some((request) => request.method === "POST")).toBe(true);
    }),
  120_000,
);
