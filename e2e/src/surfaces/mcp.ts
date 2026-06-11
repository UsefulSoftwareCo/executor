// MCP surface: the vendored mcporter fork as a programmatic MCP client, with
// headless OAuth via the target's consent strategy. Session methods are
// Effects; mcporter itself is promise-native underneath. Assertions are
// vitest's job.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { createRuntime, type Runtime } from "@executor-js/mcporter";

import type { Identity, Target } from "../target";

export interface McpCallResult {
  readonly raw: unknown;
  readonly text: string;
  readonly ok: boolean;
}

export interface McpSession {
  readonly listTools: () => Effect.Effect<ReadonlyArray<string>>;
  readonly call: (name: string, args?: Record<string, unknown>) => Effect.Effect<McpCallResult>;
  /** Find the paused executionId in `text` and resume it with approval. */
  readonly approvePaused: (
    text: string,
    content?: Record<string, unknown>,
  ) => Effect.Effect<McpCallResult>;
}

export interface McpSurface {
  readonly session: (identity: Identity) => McpSession;
}

const textOf = (result: unknown): string => {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return typeof result === "string" ? result : JSON.stringify(result);
};

export const makeMcpSurface = (target: Target): McpSurface => ({
  session: (identity) => {
    const serverName = target.name;
    let runtimePromise: Promise<Runtime> | undefined;
    let connected = false;

    const consent = target.mcpConsent?.(identity);
    const callOptions = {
      autoAuthorize: true,
      oauthSessionOptions: consent ? { consentStrategy: consent } : {},
    };

    const runtime = () => {
      if (!runtimePromise) {
        const dir = mkdtempSync(join(tmpdir(), "executor-e2e-mcp-"));
        writeFileSync(
          join(dir, "mcporter.json"),
          JSON.stringify({ mcpServers: { [serverName]: { url: target.mcpUrl } } }),
        );
        runtimePromise = createRuntime({ configPath: join(dir, "mcporter.json") });
      }
      return runtimePromise;
    };

    const listTools = () =>
      Effect.promise(async () => {
        const defs = await (await runtime()).listTools(serverName, callOptions);
        connected = true;
        return defs.map((tool: { name: string }) => tool.name);
      });

    const call = (name: string, args: Record<string, unknown> = {}) =>
      Effect.promise(async (): Promise<McpCallResult> => {
        if (!connected) {
          await (await runtime()).listTools(serverName, callOptions);
          connected = true;
        }
        const raw = await (await runtime()).callTool(serverName, name, { args, ...callOptions });
        const isError = Boolean((raw as { isError?: boolean })?.isError);
        return { raw, text: textOf(raw), ok: !isError };
      });

    return {
      listTools,
      call,
      approvePaused: (text, content = {}) =>
        Effect.suspend(() => {
          const match = /\bexecutionId:\s*(\S+)/.exec(text);
          if (!match) return Effect.die(new Error("approvePaused: executionId not found in text"));
          return call("resume", {
            executionId: match[1],
            action: "accept",
            content: JSON.stringify(content),
          });
        }),
    };
  },
});
