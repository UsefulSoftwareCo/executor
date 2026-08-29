// ---------------------------------------------------------------------------
// The Codex "Computer Use" tool surface.
//
// Computer Use is NOT a plain MCP server in current Codex: its plugin ships as
// a `node-repl` content variant, so Codex never starts the `computer-use`
// server (asking for it answers "unknown MCP server"). What actually drives a
// Mac is the `node_repl` server's `js` tool running the plugin's bundled
// `@oai/sky` package — that is what ChatGPT itself does, and Codex tags those
// calls `toolSurface: { kind: "computerUse" }`.
//
// Handing an agent a raw JavaScript REPL would be a poor tool catalog: it
// moves the whole API contract into prose and makes every call a code-writing
// exercise. So the bridge projects `@oai/sky` as ordinary, typed MCP tools —
// one per method, with real input schemas — and compiles each call back into
// the one `node_repl.js` execution that performs it. Callers see
// `list_apps` / `click` / `type_text`; the REPL stays an implementation
// detail.
//
// The surface below mirrors the `Sky` type in the plugin's own SKILL.md.
// ---------------------------------------------------------------------------

import { jsLiteral, writeJsonResult } from "./codex-repl";

/** Bundled package the REPL imports; `sky` is its single exported entry. */
const SKY_PACKAGE = "@oai/sky";

type JsonSchema = Record<string, unknown>;

const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string): JsonSchema => ({ type: "number", description });
const int = (description: string): JsonSchema => ({ type: "integer", description });

const APP: JsonSchema = str(
  "Bundle id or name of the target app, e.g. `com.apple.Safari` or `Safari`.",
);
const ELEMENT_INDEX = int(
  "Index of the target element, from the accessibility tree returned by `get_app_state`.",
);

export interface SkyToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** The `sky` method this tool calls. */
  readonly method: string;
  /** `sky.list_apps()` takes no argument object; everything else takes one. */
  readonly takesArgs: boolean;
}

const object = (
  properties: Record<string, JsonSchema>,
  required: readonly string[],
): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required: [...required] } : {}),
  additionalProperties: false,
});

export const SKY_TOOLS: readonly SkyToolDefinition[] = [
  {
    name: "list_apps",
    method: "list_apps",
    takesArgs: false,
    description:
      "List the apps on this Mac — those running now plus those used recently, with usage counts. Use this first to resolve an app's bundle id.",
    inputSchema: object({}, []),
  },
  {
    name: "get_app_state",
    method: "get_app_state",
    takesArgs: true,
    description:
      "Read an app's current state: a screenshot URL plus its accessibility tree as text. Call this before interacting, and again after actions that change the UI — element indexes come from here and are only valid for the state that produced them.",
    inputSchema: object(
      {
        app: APP,
        disableDiff: {
          type: "boolean",
          description:
            "Return the full state instead of only what changed since the previous read of this app.",
        },
      },
      ["app"],
    ),
  },
  {
    name: "click",
    method: "click",
    takesArgs: true,
    description:
      "Click an element by its accessibility index, or a point by coordinates. Prefer `element_index` — coordinates break when the window moves or resizes.",
    inputSchema: object(
      {
        app: APP,
        element_index: ELEMENT_INDEX,
        x: num("X coordinate, when clicking by position instead of element."),
        y: num("Y coordinate, when clicking by position instead of element."),
        mouse_button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Which button to click. Defaults to left.",
        },
        click_count: int("Number of clicks — 2 for a double click. Defaults to 1."),
      },
      ["app"],
    ),
  },
  {
    name: "type_text",
    method: "type_text",
    takesArgs: true,
    description:
      "Type text into the app's focused element, as keystrokes. Focus the target first (usually by clicking it).",
    inputSchema: object({ app: APP, text: str("The literal text to type.") }, ["app", "text"]),
  },
  {
    name: "press_key",
    method: "press_key",
    takesArgs: true,
    description:
      "Press a key or key combination, e.g. `Return`, `Escape`, `cmd+a`. Use this for shortcuts and navigation rather than typing control characters.",
    inputSchema: object({ app: APP, key: str("Key or combination to press.") }, ["app", "key"]),
  },
  {
    name: "paste",
    method: "paste",
    takesArgs: true,
    description:
      "Paste content into the app. Much faster and more reliable than `type_text` for anything long, and the only way to insert markdown or HTML.",
    inputSchema: object(
      {
        app: APP,
        text: str("The content to paste."),
        format: {
          type: "string",
          enum: ["text", "md", "html"],
          description: "How to interpret the pasted content.",
        },
      },
      ["app", "text", "format"],
    ),
  },
  {
    name: "scroll",
    method: "scroll",
    takesArgs: true,
    description: "Scroll an element, or the app's main view, in a direction by a number of pages.",
    inputSchema: object(
      {
        app: APP,
        element_index: ELEMENT_INDEX,
        x: num("X coordinate to scroll at, when not targeting an element."),
        y: num("Y coordinate to scroll at, when not targeting an element."),
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Direction to scroll.",
        },
        pages: num("How many pages to scroll. Fractions are allowed. Defaults to 1."),
      },
      ["app", "direction"],
    ),
  },
  {
    name: "drag",
    method: "drag",
    takesArgs: true,
    description: "Drag from one point to another inside the app, in screen coordinates.",
    inputSchema: object(
      {
        app: APP,
        from_x: num("Starting X coordinate."),
        from_y: num("Starting Y coordinate."),
        to_x: num("Ending X coordinate."),
        to_y: num("Ending Y coordinate."),
      },
      ["app", "from_x", "from_y", "to_x", "to_y"],
    ),
  },
  {
    name: "select_text",
    method: "select_text",
    takesArgs: true,
    description:
      "Select text inside an element, or place the caret before or after it. Give the text exactly as it appears in the accessibility tree, with a prefix or suffix when it is not unique.",
    inputSchema: object(
      {
        app: APP,
        element_index: ELEMENT_INDEX,
        text: str("The target text, exactly as shown in the accessibility tree."),
        prefix: str("Text immediately before the target, to disambiguate repeats."),
        suffix: str("Text immediately after the target, to disambiguate repeats."),
        selection_type: {
          type: "string",
          enum: ["text", "cursor_before", "cursor_after"],
          description: "Select the text, or place the caret. Defaults to selecting.",
        },
      },
      ["app", "element_index", "text"],
    ),
  },
  {
    name: "set_value",
    method: "set_value",
    takesArgs: true,
    description:
      "Set an element's value directly, without typing. Works only on elements the app exposes as settable.",
    inputSchema: object(
      { app: APP, element_index: ELEMENT_INDEX, value: str("The value to assign.") },
      ["app", "element_index", "value"],
    ),
  },
  {
    name: "perform_secondary_action",
    method: "perform_secondary_action",
    takesArgs: true,
    description:
      "Invoke a secondary accessibility action an element exposes, by name — the actions listed alongside it in `get_app_state`.",
    inputSchema: object(
      { app: APP, element_index: ELEMENT_INDEX, action: str("Name of the action to perform.") },
      ["app", "element_index", "action"],
    ),
  },
];

/** The tool definitions as MCP wire `Tool` objects. */
export const skyToolList = (): readonly Record<string, unknown>[] =>
  SKY_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

export const findSkyTool = (name: string): SkyToolDefinition | undefined =>
  SKY_TOOLS.find((tool) => tool.name === name);

/**
 * The `node_repl` program that performs one sky call.
 *
 * `??=` rather than a separate bootstrap step because the REPL's state is
 * persistent but its LIFETIME is not ours to assume: the thread may be new,
 * reused, or reset between calls, and a call that assumed a warm global would
 * fail exactly when the pool handed back a fresh one. Importing is cheap once
 * warm, so this is idempotent rather than conditional on bookkeeping.
 *
 * The result is written as JSON through `nodeRepl.write`, which is how the
 * REPL returns anything at all; `undefined` (the action methods) becomes
 * `null` so a caller always gets a well-formed body.
 */
export const skyCallProgram = (tool: SkyToolDefinition, args: unknown): string => {
  const call = tool.takesArgs ? `sky.${tool.method}(${jsLiteral(args)})` : `sky.${tool.method}()`;
  return [
    `globalThis.sky ??= (await import(${JSON.stringify(SKY_PACKAGE)})).sky;`,
    writeJsonResult([], `await ${call}`),
  ].join("\n");
};
