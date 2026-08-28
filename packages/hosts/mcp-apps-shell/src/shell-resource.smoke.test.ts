import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { createExecutorMcpServer } from "@executor-js/host-mcp/tool-server";
import { MCP_APPS_SHELL_RESOURCE_URI } from "@executor-js/host-mcp/create-artifact";
import type { ExecutionEngine } from "@executor-js/execution";

import { loadMcpAppsShellHtml } from "./shell-html";
import { MCP_APPS_SHELL_DOCUMENT_MARKER } from "./shell-asset-path";

// The shipped binary serves the shell from a file on disk (`build:shell` output,
// copied next to the executable by `apps/cli/src/build.ts`). If that file is
// missing the loader rejects the resource read — it used to degrade to a
// placeholder document, which hung every MCP-Apps client silently — so assert
// an MCP client reading the resource gets the REAL built shell. This replaces
// a build-time subprocess probe that hard-slept 7 seconds inside every binary
// build.

const stubEngine: ExecutionEngine<never> = {
  execute: () => Effect.succeed({ result: "ok" }),
  executeWithPause: () => Effect.succeed({ status: "completed", result: { result: "ok" } }),
  resume: () => Effect.succeed(null),
  isExecutionSettled: undefined,
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("smoke"),
  // The fake forks nothing, so there is no sandbox fiber to end.
  shutdown: Effect.void,
};

// oxlint-disable-next-line executor/no-double-cast -- boundary: MCP SDK ClientCapabilities predates the ext-apps `extensions` field
const APPS_CAPS = {
  extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
} as unknown as ClientCapabilities;

describe("MCP-Apps shell resource", () => {
  it("serves the built shell to an MCP client", async () => {
    const mcpServer = await Effect.runPromise(
      // Artifacts are opt-in per connection; the shell resource only exists on
      // a session that asked for them.
      createExecutorMcpServer({
        engine: stubEngine,
        loadAppShellHtml: loadMcpAppsShellHtml,
        artifactsEnabled: true,
      }),
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
    expect(html).toContain('id="root"');
    // The identity marker the Workers loader authenticates the document by
    // (an ASSETS-binding miss under SPA not-found handling answers with
    // index.html and a 200). Asserted here so the marker leaving the template
    // fails this suite too, not just the app builds.
    expect(html).toContain(MCP_APPS_SHELL_DOCUMENT_MARKER);
    // `vite-plugin-singlefile` inlines every asset: a shell that still points at
    // a sibling bundle would 404 inside the host's sandboxed iframe.
    //
    // Scanned over the DOCUMENT only, with the inlined script bodies blanked
    // first. The bundle is ~5 MB of JavaScript that includes React's own source
    // strings, and several of those build markup as text
    // (`n += ' href="' + e.href + '"'` inside its resource-hint code). Matching
    // the raw document therefore reports tags that exist only as characters in
    // a string literal, which no browser will ever fetch — a false positive
    // that says nothing about the property under test. What matters is whether
    // the served document itself references anything it would have to go and
    // get.
    // Only INLINE scripts are blanked. A `<script src=...>` is exactly the
    // regression this guards, so its tag has to survive the blanking — matching
    // it and its closing tag together would delete the evidence.
    const documentOnly = html.replace(
      /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g,
      "<script></script>",
    );
    const externalRefs = [...documentOnly.matchAll(/<(?:script|link)[^>]*(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((url) => !url.startsWith("data:"));
    expect(externalRefs).toEqual([]);

    await clientTransport.close();
    await serverTransport.close();
  });
});
