// MCP surface: the vendored mcporter fork as a programmatic MCP client, with
// headless OAuth via the target's consent strategy. The connect → authorize →
// code → connected lifecycle and every tool call are recorded as chat turns,
// because the MCP surface IS a chat — that's its natural transcript shape.
// Session methods are Effects; mcporter itself is promise-native underneath.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { createRuntime, type Runtime } from "../../../vendor/mcporter/dist/index.js";

import type { Recorder } from "../recorder";
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

export const makeMcpSurface = (rec: Recorder, target: Target): McpSurface => ({
  session: (identity) => {
    const serverName = target.name;
    let runtimePromise: Promise<Runtime> | undefined;
    let toolNames: ReadonlyArray<string> | undefined;

    const consent = target.mcpConsent?.(identity);
    const callOptions = {
      autoAuthorize: true,
      oauthSessionOptions: consent
        ? {
            consentStrategy: async (request: { authorizationUrl: string }) => {
              rec.auth("authorize", "OAuth required → client registered (DCR), authorizing", {
                detail: { authorizationUrl: request.authorizationUrl },
              });
              const out = await consent(request);
              rec.auth("code", "Signed in & consented → authorization code received", {
                ok: true,
              });
              return out;
            },
          }
        : {},
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

    const connect = async () => {
      if (toolNames) return toolNames;
      rec.auth("connect", `Connecting to ${target.mcpUrl}`);
      const defs = await (await runtime()).listTools(serverName, callOptions);
      rec.auth("connected", "Connected — access token acquired & cached for reuse", { ok: true });
      toolNames = defs.map((tool: { name: string }) => tool.name);
      return toolNames;
    };

    const call = (name: string, args: Record<string, unknown> = {}) =>
      Effect.promise(async (): Promise<McpCallResult> => {
        await connect();
        const started = Date.now();
        const raw = await (await runtime()).callTool(serverName, name, { args, ...callOptions });
        const isError = Boolean((raw as { isError?: boolean })?.isError);
        const text = textOf(raw);
        rec.toolCall({
          surface: "mcp",
          name,
          args,
          result: (raw as { content?: unknown })?.content ?? raw,
          ok: !isError,
          text,
          durationMs: Date.now() - started,
        });
        return { raw, text, ok: !isError };
      });

    return {
      listTools: () =>
        Effect.promise(async () => {
          const names = await connect();
          rec.toolCall({
            surface: "mcp",
            name: "tools/list",
            args: {},
            result: names,
            ok: true,
            text: names.join(", "),
          });
          return names;
        }),
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
