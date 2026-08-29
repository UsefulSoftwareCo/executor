// ---------------------------------------------------------------------------
// Curated Codex plugin metadata — the isomorphic half of Codex plugin
// discovery. The names and summaries here are BOTH the searchable catalog
// presets (presets.ts, bundled client-side) and the curated entries the
// node-only scanner reports (codex-plugins.ts), so the two can never drift.
// Keep the summaries carrying the words people actually search for
// ("iMessage", "texts", "computer use", "screen activity").
// ---------------------------------------------------------------------------

export interface CuratedCodexPlugin {
  /** Card/preset id, e.g. `codex-messages`. */
  readonly id: string;
  /** The Codex plugin name in the plugin cache. */
  readonly pluginName: string;
  readonly name: string;
  /** Suggested integration slug, e.g. `codex_messages`. */
  readonly slug: string;
  /** The MCP server name this plugin registers inside Codex — the `server`
   *  the app-server bridge calls tools against. */
  readonly server: string;
  /** Present when the plugin has no MCP server of its own and its API is
   *  projected onto another one. Computer Use ships as a `node-repl` variant:
   *  Codex never starts a `computer-use` server, and the API is driven through
   *  `node_repl` — see `codex-sky-tools.ts`. */
  readonly surface?: "sky";
  readonly summary: string;
}

export const CODEX_SETUP_HINT =
  "Install the Codex app, sign in, and use this plugin once inside Codex so macOS grants its permissions (Full Disk Access, Contacts, Automation).";

export const CURATED_CODEX_PLUGINS: readonly CuratedCodexPlugin[] = [
  // Names are exactly the plugins' own displayNames — nothing invented, no
  // provenance suffix. Codex provenance shows in the summaries and on the
  // focused add screen; search keywords people type ("imessage", "apple",
  // "texts") live in the summaries.
  {
    id: "codex-messages",
    pluginName: "messages",
    name: "Messages",
    slug: "codex_messages",
    server: "messages",
    summary:
      "Read, search, and send iMessage/SMS texts through Apple's Messages app on this Mac, via the Codex plugin. Reads and sends are approved in its native dialogs.",
  },
  {
    id: "codex-computer-use",
    pluginName: "computer-use",
    name: "Computer Use",
    slug: "codex_computer_use",
    server: "node_repl",
    surface: "sky",
    summary:
      "Control macOS desktop apps via the Codex plugin: read the screen and accessibility tree, click, type, and scroll.",
  },
  {
    id: "codex-computer-history",
    pluginName: "computer-history",
    name: "Computer History",
    slug: "codex_computer_history",
    server: "computer-history",
    summary:
      "Ask about recent on-screen activity from Codex's private local record (requires Computer History enabled in Codex).",
  },
];

export const isCodexPresetId = (id: string | undefined): boolean =>
  id !== undefined && CURATED_CODEX_PLUGINS.some((plugin) => plugin.id === id);
