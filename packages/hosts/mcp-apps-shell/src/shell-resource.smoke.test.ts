import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { createExecutorMcpServer } from "@executor-js/host-mcp/tool-server";
import { MCP_APPS_SHELL_RESOURCE_URI } from "@executor-js/host-mcp/create-artifact";
import type { ExecutionEngine } from "@executor-js/execution";

import { loadMcpAppsShellHtml, MCP_APPS_SHELL_NOT_BUILT_HTML } from "./shell-html";

// The shipped binary serves the shell from a file on disk (`build:shell` output,
// copied next to the executable by `apps/cli/src/build.ts`). If that file is
// missing the loader silently degrades to a placeholder and every generated UI
// renders blank — so assert an MCP client reading the resource gets the REAL
// built shell, not the placeholder. This replaces a build-time subprocess probe
// that hard-slept 7 seconds inside every binary build.

const stubEngine: ExecutionEngine<never> = {
  execute: () => Effect.succeed({ result: "ok" }),
  executeWithPause: () => Effect.succeed({ status: "completed", result: { result: "ok" } }),
  resume: () => Effect.succeed(null),
  isExecutionSettled: undefined,
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("smoke"),
};

// oxlint-disable-next-line executor/no-double-cast -- boundary: MCP SDK ClientCapabilities predates the ext-apps `extensions` field
const APPS_CAPS = {
  extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
} as unknown as ClientCapabilities;

describe("MCP-Apps shell resource", () => {
  it("serves the built shell to an MCP client, not the 'Shell not built' placeholder", async () => {
    const mcpServer = await Effect.runPromise(
      createExecutorMcpServer({ engine: stubEngine, loadAppShellHtml: loadMcpAppsShellHtml }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "shell-smoke", version: "1.0.0" },
      { capabilities: APPS_CAPS },
    );
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);

    const read = await client.readResource({ uri: MCP_APPS_SHELL_RESOURCE_URI });
    const [content] = read.contents;
    expect(content.mimeType).toBe(RESOURCE_MIME_TYPE);
    // The shell is served as text, never as a blob.
    expect("text" in content).toBe(true);
    const html = "text" in content ? content.text : "";
    expect(html).not.toBe(MCP_APPS_SHELL_NOT_BUILT_HTML);
    expect(html).not.toContain("Shell not built");
    expect(html).toContain('id="root"');
    // `vite-plugin-singlefile` inlines every asset: a shell that still points at
    // a sibling bundle would 404 inside the host's sandboxed iframe.
    const externalRefs = [...html.matchAll(/<(?:script|link)[^>]*(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((url) => !url.startsWith("data:"));
    expect(externalRefs).toEqual([]);

    await clientTransport.close();
    await serverTransport.close();
  });
});
