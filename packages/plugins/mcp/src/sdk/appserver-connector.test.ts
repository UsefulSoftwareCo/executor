import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import { fileURLToPath } from "node:url";

import { createMcpConnector, type StdioConnectorInput } from "./connection";

// ---------------------------------------------------------------------------
// The Codex app-server bridge, driven end to end through the ORDINARY MCP
// client path: `createMcpConnector` with an `appServer` marker spawns the
// fixture (a fake `codex app-server` with real protocol shapes), and the
// standard `Client` handshakes, lists, calls, and answers elicitations
// against it. Nothing here touches the bridge internals — if these pass, the
// discover/invoke/health paths work unchanged on top.
// ---------------------------------------------------------------------------

const fixture = fileURLToPath(new URL("./appserver-test-server.ts", import.meta.url));

const appServerInput = (
  server: string,
  appServer?: { readonly surface?: "sky" | "browser"; readonly modulePath?: string },
): StdioConnectorInput => ({
  transport: "stdio",
  command: "bun",
  args: ["run", fixture],
  env: { CODEX_HOME: "/tmp/fixture-codex-home" },
  appServer: { server, ...appServer },
});

const withConnection = (input: StdioConnectorInput) =>
  Effect.acquireRelease(createMcpConnector(input).pipe(Effect.orDie), (connection) =>
    Effect.promise(connection.close),
  );

describe("codex app-server bridge", () => {
  it.effect("handshakes, follows status pagination, and lists the server's tools", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(appServerInput("messages"));

        const tools = yield* Effect.promise(() => connection.client.listTools());
        expect(tools.tools.map(({ name }) => name).sort()).toEqual(["echo", "needs_approval"]);
        const echo = tools.tools.find(({ name }) => name === "echo");
        expect(echo?.description).toBe("Echo the arguments back");
        expect(echo?.inputSchema).toMatchObject({ type: "object" });
      }),
    ),
  );

  it.effect("calls a tool and carries content, structuredContent, and the spawn env through", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(appServerInput("messages"));

        const result = yield* Effect.promise(() =>
          connection.client.callTool({ name: "echo", arguments: { text: "hi" } }),
        );
        expect(result.isError).toBeFalsy();
        expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ text: "hi" }) }]);
        // CODEX_HOME must reach the fixture's process env through the spawn.
        expect(result.structuredContent).toEqual({ codexHome: "/tmp/fixture-codex-home" });
      }),
    ),
  );

  it.effect("bridges an app-server elicitation to the client's elicitation/create handler", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(appServerInput("messages"));
        const prompts: string[] = [];
        connection.client.setRequestHandler("elicitation/create", (request) => {
          prompts.push(request.params.message);
          return Promise.resolve({ action: "accept" as const, content: {} });
        });

        const result = yield* Effect.promise(() =>
          connection.client.callTool({ name: "needs_approval", arguments: {} }),
        );
        expect(result.content).toEqual([{ type: "text", text: "approved" }]);
        expect(prompts).toEqual(["Allow the fixture to proceed?"]);
      }),
    ),
  );

  it.effect("starts the thread with an approval policy that lets prompts through", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Codex declines MCP elicitations ITSELF on a thread whose approval
        // policy does not allow them — the prompt never reaches the client and
        // the tool just reports "access was not approved". The fixture only
        // elicits when the bridge asked for a permitting policy, so reaching
        // the handler at all is the assertion.
        const connection = yield* withConnection(appServerInput("messages"));
        let prompted = false;
        connection.client.setRequestHandler("elicitation/create", () => {
          prompted = true;
          return Promise.resolve({ action: "accept" as const, content: {} });
        });

        const result = yield* Effect.promise(() =>
          connection.client.callTool({ name: "needs_approval", arguments: {} }),
        );
        expect(prompted, "the plugin's own approval prompt reached the client").toBe(true);
        expect(result.isError).toBeFalsy();
      }),
    ),
  );

  it.effect("a declined elicitation reaches the app-server as a decline, not an approval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(appServerInput("messages"));
        connection.client.setRequestHandler("elicitation/create", () =>
          Promise.resolve({ action: "decline" as const }),
        );

        const result = yield* Effect.promise(() =>
          connection.client.callTool({ name: "needs_approval", arguments: {} }),
        );
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: "text", text: "denied: decline" }]);
      }),
    ),
  );

  // -------------------------------------------------------------------------
  // Computer Use: projected onto `node_repl`, not a server of its own.
  // -------------------------------------------------------------------------

  it.effect("the sky surface lists typed Computer Use tools, not the raw REPL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(appServerInput("node_repl", { surface: "sky" }));

        const tools = yield* Effect.promise(() => connection.client.listTools());
        const names = tools.tools.map(({ name }) => name);
        expect(names, "the raw REPL is not exposed").not.toContain("js");
        expect(names).toEqual(expect.arrayContaining(["list_apps", "click", "type_text"]));
        const click = tools.tools.find(({ name }) => name === "click");
        expect(click?.inputSchema, "tools carry real schemas").toMatchObject({
          type: "object",
          required: ["app"],
        });
      }),
    ),
  );

  it.effect("a sky tool call compiles to one node_repl program carrying its arguments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(appServerInput("node_repl", { surface: "sky" }));

        // Quotes in the arguments matter: they are embedded into a JS source
        // text, so the encoding has to survive them exactly.
        const args = { app: "com.apple.Safari", text: 'hi "there"' };
        const result = yield* Effect.promise(() =>
          connection.client.callTool({ name: "type_text", arguments: args }),
        );
        // The fixture echoes the program the bridge compiled.
        const program = (result.content as readonly { readonly text: string }[])[0]!.text;
        expect(program, "imports the bundled sky package idempotently").toContain(
          'globalThis.sky ??= (await import("@oai/sky")).sky;',
        );
        expect(program, "calls the mapped method with the arguments verbatim").toContain(
          `await sky.type_text(${JSON.stringify(args)})`,
        );
        expect(program, "returns the result as JSON through the REPL").toContain(
          "nodeRepl.write(JSON.stringify(result ?? null));",
        );
        expect(program, "runs in its own scope so a reused REPL session stays clean").toContain(
          "await (async () => {",
        );
      }),
    ),
  );

  it.effect("an argument-less sky tool calls its method with no argument object", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(appServerInput("node_repl", { surface: "sky" }));

        const result = yield* Effect.promise(() =>
          connection.client.callTool({ name: "list_apps", arguments: {} }),
        );
        const program = (result.content as readonly { readonly text: string }[])[0]!.text;
        expect(program).toContain("await sky.list_apps();");
      }),
    ),
  );

  it.effect("a tool outside the sky surface is refused rather than sent to the REPL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(appServerInput("node_repl", { surface: "sky" }));

        const outcome = yield* Effect.promise(() =>
          connection.client.callTool({ name: "js", arguments: { code: "process.exit(0)" } }).then(
            () => "unexpected success",
            (failure: Error) => failure.message,
          ),
        );
        expect(outcome).toContain("js");
      }),
    ),
  );

  // -------------------------------------------------------------------------
  // Chrome: also projected onto `node_repl`, but handle-based.
  // -------------------------------------------------------------------------

  const BROWSER_MODULE = "/codex/chrome/latest/scripts/browser-client.mjs";
  const browserInput = () =>
    appServerInput("node_repl", { surface: "browser", modulePath: BROWSER_MODULE });

  it.effect("the browser surface lists typed Chrome tools, not the raw REPL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(browserInput());

        const names = yield* Effect.promise(() =>
          connection.client.listTools().then((result) => result.tools.map(({ name }) => name)),
        );
        expect(names, "the raw REPL is not exposed").not.toContain("js");
        expect(names).toEqual(
          expect.arrayContaining(["list_tabs", "new_tab", "navigate", "read_page", "click"]),
        );
      }),
    ),
  );

  it.effect("a browser call imports the machine's own client and resolves a tab", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(browserInput());

        const result = yield* Effect.promise(() =>
          connection.client.callTool({
            name: "navigate",
            arguments: { url: "https://example.com/" },
          }),
        );
        const program = (result.content as readonly { readonly text: string }[])[0]!.text;
        expect(program, "imports the scanner-resolved client path").toContain(
          `await import(${JSON.stringify(BROWSER_MODULE)})`,
        );
        expect(program, "caches the runtime across calls in the pooled session").toContain(
          "globalThis.__executorBrowser ??=",
        );
        expect(program, "falls back to the selected tab, opening one if needed").toContain(
          "(await __browser.tabs.selected()) ?? (await __browser.tabs.new())",
        );
        expect(program).toContain("await __tab.goto(__args.url)");
      }),
    ),
  );

  it.effect("stamps REPL calls with the turn metadata the Chrome client requires", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Without this the real client refuses every call with "Missing
        // required Codex turn metadata": Codex normally stamps a REPL call
        // with its issuing turn, and this bridge runs no turns.
        const connection = yield* withConnection(browserInput());

        const result = yield* Effect.promise(() =>
          connection.client.callTool({ name: "list_tabs", arguments: {} }),
        );
        const meta = (result.structuredContent as { readonly meta: Record<string, unknown> }).meta;
        const turn = meta["x-codex-turn-metadata"] as Record<string, string>;
        expect(typeof turn.session_id, "the pooled thread is the session").toBe("string");
        expect(typeof turn.turn_id, "each call is its own turn").toBe("string");
      }),
    ),
  );

  it.effect("a tab-less browser tool skips tab resolution entirely", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(browserInput());

        const result = yield* Effect.promise(() =>
          connection.client.callTool({ name: "list_tabs", arguments: {} }),
        );
        const program = (result.content as readonly { readonly text: string }[])[0]!.text;
        expect(program).toContain("await __browser.tabs.list()");
        expect(program, "no tab is resolved for a browser-level call").not.toContain("const __tab");
      }),
    ),
  );

  it.effect("a server name Codex does not report fails the tools listing, not the connect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(appServerInput("not-installed"));

        const outcome = yield* Effect.promise(() =>
          connection.client.listTools().then(
            () => "unexpected success",
            (failure: Error) => failure.message,
          ),
        );
        expect(outcome).toContain('"not-installed"');
      }),
    ),
  );

  it.effect("a missing codex binary surfaces as a connection error", () =>
    Effect.gen(function* () {
      const error = yield* createMcpConnector({
        transport: "stdio",
        command: "/nonexistent/codex",
        args: ["app-server"],
        appServer: { server: "messages" },
      }).pipe(Effect.flip);

      expect(Predicate.isTagged(error, "McpConnectionError")).toBe(true);
    }),
  );
});
