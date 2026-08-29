// ---------------------------------------------------------------------------
// The Codex "Chrome" tool surface.
//
// Like Computer Use, the Chrome plugin ships no MCP server: it is skills-only,
// and browser control happens by importing its bundled
// `scripts/browser-client.mjs` inside Codex's `node_repl` and driving the
// runtime it returns. This module projects that runtime as typed MCP tools and
// compiles each call into the one REPL program that performs it, exactly as
// `codex-sky-tools.ts` does for Computer Use.
//
// The API is handle-based (`agent` → `browser` → `tab`) rather than flat, so
// two things differ from the sky surface:
//
//   * the runtime and the selected browser are cached in the REPL session,
//     because `setupBrowserRuntime()` connects to the browser extension and is
//     far too expensive to repeat per call. Pooled bridge connections
//     (`isPoolableConnectorInput`) are what make that cache worth having — the
//     REPL session now outlives a single tool call.
//   * a tab is addressed by its id, which callers read from `list_tabs` or
//     `new_tab`. Omitting it uses the selected tab, opening one if the browser
//     has none, so simple journeys never have to thread an id through.
//
// Interaction goes through the tab's `dom_cua` API, NOT `ax`: the plugin's own
// API reference marks `ax` unsupported on the `extension`, `iab`, and `cdp`
// backends, and Chrome is reached through the extension — calling it there
// fails with a bare "Cannot read properties of undefined". `dom_cua` carries
// no such restriction. Node ids come from `read_page`, and are only valid for
// the snapshot that produced them.
// ---------------------------------------------------------------------------

import { jsLiteral, writeJsonResult } from "./codex-repl";

type JsonSchema = Record<string, unknown>;

const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string): JsonSchema => ({ type: "number", description });

const TAB_ID = str(
  "Id of the tab to act on, from `list_tabs` or `new_tab`. Omit to use the selected tab.",
);
const NODE_ID = str(
  "Id of the target element, from the DOM snapshot returned by `read_page`. Only valid for the snapshot it came from.",
);

const object = (
  properties: Record<string, JsonSchema>,
  required: readonly string[],
): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required: [...required] } : {}),
  additionalProperties: false,
});

export interface BrowserToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** Whether the program resolves a tab before running `expression`. */
  readonly needsTab: boolean;
  /** The JS expression to await, given the caller's arguments as `__args`
   *  and (when `needsTab`) the resolved tab as `__tab`. */
  readonly expression: string;
}

export const BROWSER_TOOLS: readonly BrowserToolDefinition[] = [
  {
    name: "list_tabs",
    description: "List the browser's open tabs with their ids, titles, and URLs.",
    inputSchema: object({}, []),
    needsTab: false,
    expression: "await __browser.tabs.list()",
  },
  {
    name: "new_tab",
    description: "Open a new tab, optionally at a URL, and return its id, title, and URL.",
    inputSchema: object({ url: str("URL to open in the new tab.") }, []),
    needsTab: false,
    expression: [
      "await (async () => {",
      "  const tab = await __browser.tabs.new();",
      "  if (__args.url) await tab.goto(__args.url);",
      "  return { id: tab.id, title: await tab.title(), url: await tab.url() };",
      "})()",
    ].join("\n"),
  },
  {
    name: "navigate",
    description: "Open a URL in a tab. Follow with `read_page` to see the result.",
    inputSchema: object({ tab_id: TAB_ID, url: str("The URL to open.") }, ["url"]),
    needsTab: true,
    expression: [
      "await (async () => {",
      "  await __tab.goto(__args.url);",
      "  return { id: __tab.id, title: await __tab.title(), url: await __tab.url() };",
      "})()",
    ].join("\n"),
  },
  {
    name: "page_info",
    description: "Get a tab's current title and URL, without reading the page.",
    inputSchema: object({ tab_id: TAB_ID }, []),
    needsTab: true,
    expression:
      "await (async () => ({ id: __tab.id, title: await __tab.title(), url: await __tab.url() }))()",
  },
  {
    name: "read_page",
    description:
      "Read the page as a filtered DOM snapshot: the interactable elements with an id for each. Call this before interacting, and again after anything that changes the page — ids are only valid for the snapshot that produced them.",
    inputSchema: object({ tab_id: TAB_ID }, []),
    needsTab: true,
    expression: "await __tab.dom_cua.get_visible_dom()",
  },
  {
    name: "click",
    description:
      "Click an element by its node id from `read_page`. Clicking is also how you focus a field before typing.",
    inputSchema: object(
      {
        tab_id: TAB_ID,
        node_id: NODE_ID,
        double: {
          type: "boolean",
          description: "Double-click instead of a single click.",
        },
      },
      ["node_id"],
    ),
    needsTab: true,
    expression: [
      "await (__args.double",
      "  ? __tab.dom_cua.double_click({ node_id: __args.node_id })",
      "  : __tab.dom_cua.click({ node_id: __args.node_id }))",
    ].join("\n"),
  },
  {
    name: "type_text",
    description:
      "Type text into the focused element. Click the target field first — typing goes wherever focus already is.",
    inputSchema: object({ tab_id: TAB_ID, text: str("The literal text to type.") }, ["text"]),
    needsTab: true,
    expression: "await __tab.dom_cua.type({ text: __args.text })",
  },
  {
    name: "press_key",
    description:
      'Press a key combination at the focused element, e.g. `["Enter"]` or `["Meta","a"]`. Use this for submitting and for shortcuts.',
    inputSchema: object(
      {
        tab_id: TAB_ID,
        keys: {
          type: "array",
          items: { type: "string" },
          description: 'The keys to press together, e.g. ["Enter"].',
        },
      },
      ["keys"],
    ),
    needsTab: true,
    expression: "await __tab.dom_cua.keypress({ keys: __args.keys })",
  },
  {
    name: "scroll",
    description: "Scroll the page, or one element, by a pixel delta.",
    inputSchema: object(
      {
        tab_id: TAB_ID,
        node_id: str("Id of an element to scroll within. Omit to scroll the page."),
        x: num("Horizontal scroll delta in pixels. Defaults to 0."),
        y: num("Vertical scroll delta in pixels. Positive scrolls down. Defaults to 0."),
      },
      [],
    ),
    needsTab: true,
    expression: [
      "await __tab.dom_cua.scroll({",
      "  ...(__args.node_id ? { node_id: __args.node_id } : {}),",
      "  x: __args.x ?? 0,",
      "  y: __args.y ?? 0,",
      "})",
    ].join("\n"),
  },
  {
    name: "find_elements",
    description:
      "Find elements by their visible text or ARIA role and return locator metadata — useful when a DOM snapshot is large or an element has no stable id.",
    inputSchema: object(
      {
        tab_id: TAB_ID,
        text: str("Visible text to match."),
        role: str("ARIA role to match, e.g. `button` or `link`."),
        name: str("Accessible name to match, used together with `role`."),
      },
      [],
    ),
    needsTab: true,
    expression: [
      "await (async () => {",
      "  const pw = __tab.playwright;",
      "  const locator = __args.role",
      "    ? pw.getByRole(__args.role, __args.name ? { name: __args.name } : {})",
      "    : pw.getByText(__args.text, {});",
      "  return await locator.all();",
      "})()",
    ].join("\n"),
  },
  {
    name: "go_back",
    description: "Navigate the tab back in its history.",
    inputSchema: object({ tab_id: TAB_ID }, []),
    needsTab: true,
    expression: "await __tab.back()",
  },
  {
    name: "go_forward",
    description: "Navigate the tab forward in its history.",
    inputSchema: object({ tab_id: TAB_ID }, []),
    needsTab: true,
    expression: "await __tab.forward()",
  },
  {
    name: "reload",
    description: "Reload the tab.",
    inputSchema: object({ tab_id: TAB_ID }, []),
    needsTab: true,
    expression: "await __tab.reload()",
  },
  {
    name: "close_tab",
    description: "Close a tab.",
    inputSchema: object({ tab_id: TAB_ID }, ["tab_id"]),
    needsTab: true,
    expression: "await __tab.close()",
  },
  {
    name: "export_content",
    description:
      "Export the tab's readable content to a file on disk and return its path. Use this to read a long page rather than paging through its accessibility state.",
    inputSchema: object({ tab_id: TAB_ID }, []),
    needsTab: true,
    expression: "await __tab.content.export()",
  },
];

export const browserToolList = (): readonly Record<string, unknown>[] =>
  BROWSER_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

export const findBrowserTool = (name: string): BrowserToolDefinition | undefined =>
  BROWSER_TOOLS.find((tool) => tool.name === name);

/** Cached on the REPL session because `setupBrowserRuntime()` connects to the
 *  browser extension — far too expensive per call. `??=` keeps it correct
 *  whether the session is warm or brand new. */
const runtimePreamble = (modulePath: string): string =>
  [
    "globalThis.__executorBrowser ??= await (async () => {",
    `  const { setupBrowserRuntime } = await import(${jsLiteral(modulePath)});`,
    "  const agent = await setupBrowserRuntime();",
    "  return { agent, browser: await agent.browsers.getDefault() };",
    "})();",
  ].join("\n");

/** Resolve the tab a call acts on: the named one, else the selected one, else
 *  a new one — so a caller that never mentions a tab still works. */
const TAB_PREAMBLE = [
  "const __tab = __args.tab_id",
  "  ? await __browser.tabs.get(__args.tab_id)",
  "  : ((await __browser.tabs.selected()) ?? (await __browser.tabs.new()));",
].join("\n");

/** The `node_repl` program that performs one browser call. */
export const browserCallProgram = (
  tool: BrowserToolDefinition,
  args: unknown,
  modulePath: string,
): string =>
  [
    runtimePreamble(modulePath),
    writeJsonResult(
      [
        "const __browser = globalThis.__executorBrowser.browser;",
        `const __args = ${jsLiteral(args ?? {})} ?? {};`,
        ...(tool.needsTab ? [TAB_PREAMBLE] : []),
      ],
      tool.expression,
    ),
  ].join("\n");
