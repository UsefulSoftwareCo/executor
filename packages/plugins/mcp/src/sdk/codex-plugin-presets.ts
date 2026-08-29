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
  /** A public image for this plugin, used when the machine-local icon cannot
   *  be read (i.e. Codex is not installed here). Only some plugins have one
   *  published; the rest fall back to the provider's mark. */
  readonly publicIcon?: string;
  /** Present when the plugin has no MCP server of its own and its API is
   *  projected onto another one. Computer Use and Chrome both ship as
   *  skills/`node-repl` content: Codex never starts a server for either, and
   *  their APIs are driven through `node_repl` — see `codex-sky-tools.ts` and
   *  `codex-browser-tools.ts`. */
  readonly surface?: "sky" | "browser";
  /** What must exist on disk for this card to be usable, beyond the `codex`
   *  CLI itself. `computer-use-app` is the shared Codex Computer Use app;
   *  `chrome-plugin` is the Chrome plugin's bundled browser client; `codex`
   *  means the CLI alone is enough (a server Codex always carries). */
  readonly requires: "computer-use-app" | "chrome-plugin" | "codex";
  readonly summary: string;
}

/** What to do when a card is not usable yet.
 *
 *  Written as numbered steps rather than one sentence: a person reading this
 *  has just been told they cannot proceed, and the useful answer is the
 *  shortest ordered path to being able to. Each step names where to go, and
 *  the last one says to come back — otherwise the card is a dead end. The
 *  plugin's own name is substituted in, so the instruction is about the thing
 *  the person clicked rather than about plugins in general. */
export const setupSteps = (
  requires: CuratedCodexPlugin["requires"],
  name: string,
): readonly string[] => {
  const install = "Install the Codex app from openai.com/codex, then sign in.";
  const finish = "Come back here and add it.";
  if (requires === "codex") return [install, finish];
  if (requires === "chrome-plugin") {
    return [
      install,
      "In Codex, open Settings \u2192 Computer use and install the ChatGPT browser extension.",
      "Use Chrome once inside Codex, so it can reach your browser.",
      finish,
    ];
  }
  return [
    install,
    `Open ${name} once inside Codex. macOS asks for its permissions the first time \u2014 Full Disk Access, Contacts, and Automation.`,
    finish,
  ];
};

/** The steps as one string, for the wire and for plain-text surfaces. */
export const setupHint = (requires: CuratedCodexPlugin["requires"], name: string): string =>
  setupSteps(requires, name)
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");

/** Where a person goes to get what a card needs.
 *
 *  Linked rather than only described: a card that cannot be used is a dead end
 *  unless it hands over the next step. Chrome's own requirement is documented
 *  on the Computer Use page, so it points there instead of the app download. */
export const setupUrl = (requires: CuratedCodexPlugin["requires"]): string =>
  requires === "chrome-plugin"
    ? "https://learn.chatgpt.com/docs/computer-use"
    : "https://openai.com/codex";

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
    // Served by the app itself (`packages/app/public`), because the Messages
    // app icon is published nowhere hotlinkable: it is a system app, absent
    // from the App Store artwork API, and `messages.apple.com` resolves to
    // the plain Apple mark. Root-relative, so local and cloud both serve it.
    publicIcon: "/plugin-icons/messages.webp",
    requires: "computer-use-app",
    server: "messages",
    summary:
      "Read, search, and send iMessage/SMS texts through Apple's Messages app on this Mac, via the Codex plugin. Reads and sends are approved in its native dialogs.",
  },
  {
    id: "codex-computer-use",
    pluginName: "computer-use",
    name: "Computer Use",
    slug: "codex_computer_use",
    publicIcon: "https://learn.chatgpt.com/images/codex/icons/computer-use-plugin-icon.png",
    requires: "computer-use-app",
    server: "node_repl",
    surface: "sky",
    summary:
      "Control macOS desktop apps via the Codex plugin: read the screen and accessibility tree, click, type, and scroll.",
  },
  {
    // Chrome is skills-only: its API is the bundled `browser-client.mjs`,
    // driven through `node_repl` exactly as Computer Use drives `@oai/sky`.
    id: "codex-chrome",
    pluginName: "chrome",
    name: "Chrome",
    slug: "codex_chrome",
    publicIcon: "https://learn.chatgpt.com/images/codex/icons/chrome-production-large.png",
    server: "node_repl",
    surface: "browser",
    requires: "chrome-plugin",
    summary:
      "Control the Chrome browser on this Mac through the Codex plugin: open tabs, navigate to a URL, read the page, click, and type. Uses your real Chrome, with its logged-in sessions.",
  },
  {
    // A server Codex carries itself — no plugin app, no local binary beyond
    // the CLI.
    id: "codex-openai-docs",
    pluginName: "openai-developers",
    name: "OpenAI Developer Docs",
    slug: "codex_openai_docs",
    server: "openaiDeveloperDocs",
    requires: "codex",
    summary:
      "Search and read OpenAI's developer documentation and API reference, including OpenAPI specs and endpoint listings, via the Codex plugin.",
  },
  {
    id: "codex-computer-history",
    pluginName: "computer-history",
    name: "Computer History",
    slug: "codex_computer_history",
    requires: "computer-use-app",
    server: "computer-history",
    summary:
      "Ask about recent on-screen activity from Codex's private local record (requires Computer History enabled in Codex).",
  },
];

export const isCodexPresetId = (id: string | undefined): boolean =>
  id !== undefined && CURATED_CODEX_PLUGINS.some((plugin) => plugin.id === id);
