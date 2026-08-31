import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { scanCodexPlugins } from "./codex-plugins";

// ---------------------------------------------------------------------------
// `scanCodexPlugins` reads a Codex home layout from disk:
//
//   <home>/computer-use/Codex Computer Use.app/…/SkyComputerUseClient   (curated)
//   <home>/plugins/cache/<source>/<name>/<version>/.codex-plugin/plugin.json
//
// The curated plugins must always be reported — available when their required
// client content exists, with a setup hint when it does not — and the cache
// scan must pick each plugin's newest version, resolve its relative command
// and cwd against that version dir, skip remote (http) servers, and never fail
// the whole scan on a malformed entry.
// ---------------------------------------------------------------------------

const CLIENT_RELATIVE = join(
  "computer-use",
  "Codex Computer Use.app",
  "Contents",
  "SharedSupport",
  "SkyComputerUseClient.app",
  "Contents",
  "MacOS",
  "SkyComputerUseClient",
);

const tempHomes: string[] = [];

const makeHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  tempHomes.push(home);
  return home;
};

afterEach(() => {
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const writeExecutable = (file: string): void => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
};

const writeCachedPlugin = (
  home: string,
  input: {
    readonly source?: string;
    readonly name: string;
    readonly version: string;
    readonly manifest?: unknown;
    readonly servers?: unknown;
  },
): string => {
  const versionDir = join(
    home,
    "plugins",
    "cache",
    input.source ?? "openai-curated-remote",
    input.name,
    input.version,
  );
  mkdirSync(join(versionDir, ".codex-plugin"), { recursive: true });
  writeFileSync(
    join(versionDir, ".codex-plugin", "plugin.json"),
    JSON.stringify(
      input.manifest ?? {
        name: input.name,
        mcpServers: "./.mcp.json",
        interface: { displayName: input.name, shortDescription: `${input.name} server` },
      },
    ),
  );
  if (input.servers !== undefined) {
    writeFileSync(join(versionDir, ".mcp.json"), JSON.stringify(input.servers));
  }
  return versionDir;
};

/** Chrome's bundled browser client, reached through the `latest` symlink
 *  Codex maintains beside the versioned directories. */
const CHROME_CLIENT_RELATIVE = join(
  "plugins",
  "cache",
  "openai-bundled",
  "chrome",
  "latest",
  "scripts",
  "browser-client.mjs",
);

const writeChromePlugin = (home: string): void => {
  const file = join(home, CHROME_CLIENT_RELATIVE);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "export const setupBrowserRuntime = async () => ({});\n");
};

const writeComputerUsePlugin = (
  home: string,
  version = "1.0.0",
  source = "openai-bundled",
): string => {
  const file = join(
    home,
    "plugins",
    "cache",
    source,
    "computer-use",
    version,
    "scripts",
    "computer-use-client.mjs",
  );
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "export const setupComputerUseRuntime = async () => ({});\n");
  return file;
};

/** A fake `codex` CLI inside the temp home, passed explicitly so the scan
 *  never resolves the machine's real install through PATH. */
const writeCodexCli = (home: string): string => {
  const cli = join(home, "bin", "codex");
  writeExecutable(cli);
  return cli;
};

describe("scanCodexPlugins", () => {
  it("reports the curated plugins as app-server recipes when Codex is fully installed", () => {
    const home = makeHome();
    writeExecutable(join(home, CLIENT_RELATIVE));
    const computerUseClient = writeComputerUsePlugin(home);
    writeChromePlugin(home);
    const cli = writeCodexCli(home);

    const entries = scanCodexPlugins({ codexHome: home, codexCli: cli });
    const curated = entries.filter((entry) => entry.source === "curated");

    expect(curated.map((entry) => entry.id)).toEqual([
      "codex-messages",
      "codex-computer-use",
      "codex-chrome",
      "codex-openai-docs",
      "codex-computer-history",
    ]);
    for (const entry of curated) {
      expect(entry.available, entry.id).toBe(true);
      // Curated plugins go through the app-server bridge — the plugins' own
      // service only honours Codex host sessions, so their binaries are never
      // spawned directly.
      expect(entry.command).toBe(cli);
      expect(entry.args).toEqual(["app-server"]);
      expect(entry.env).toEqual({ CODEX_HOME: home });
      expect(entry.setupHint).toBeUndefined();
    }
    // Computer Use and Chrome have no MCP server of their own in current
    // Codex: both ship as node-repl content, so they target `node_repl` with a
    // projected surface. Each carries the plugin-owned module its surface
    // imports; Chrome's is resolved through the version-proof `latest` symlink.
    // Each entry also carries its own preset id, so a macOS permission
    // failure can name the exact grant that plugin needs.
    expect(curated.map((entry) => entry.appServer)).toEqual([
      { presetId: "codex-messages", server: "messages" },
      {
        presetId: "codex-computer-use",
        server: "node_repl",
        surface: "sky",
        modulePath: computerUseClient,
      },
      {
        presetId: "codex-chrome",
        server: "node_repl",
        surface: "browser",
        modulePath: join(home, CHROME_CLIENT_RELATIVE),
      },
      { presetId: "codex-openai-docs", server: "openaiDeveloperDocs" },
      { presetId: "codex-computer-history", server: "computer-history" },
    ]);
  });

  it("reports every curated plugin with a setup hint when Codex is not installed", () => {
    const home = makeHome();

    const entries = scanCodexPlugins({ codexHome: home, codexCli: join(home, "bin", "codex") });
    const curated = entries.filter((entry) => entry.source === "curated");

    expect(curated).toHaveLength(5);
    for (const entry of curated) {
      expect(entry.available, entry.id).toBe(false);
      expect(entry.setupHint, entry.id).toContain("Codex");
    }
  });

  it("gates each curated plugin on what it actually needs, not on Codex alone", () => {
    const home = makeHome();
    const cli = writeCodexCli(home);

    const byId = new Map(
      scanCodexPlugins({ codexHome: home, codexCli: cli }).map((entry) => [entry.id, entry]),
    );

    // `codex app-server` starts, but the plugins' own content is absent: no
    // `messages` server without the Computer Use app, no browser client
    // without the Chrome plugin. Those cards must not claim readiness.
    expect(byId.get("codex-messages")?.available).toBe(false);
    expect(byId.get("codex-computer-use")?.available).toBe(false);
    expect(byId.get("codex-chrome")?.available).toBe(false);
    // Each card's steps are about ITS requirement: Chrome needs the browser
    // extension, which no other card mentions.
    expect(byId.get("codex-chrome")?.setupHint).toContain("browser extension");
    // A card that cannot be used still hands over where to go, and shows the
    // plugin's published mark rather than a gap.
    expect(byId.get("codex-messages")?.setupUrl).toBe("https://openai.com/codex");
    expect(byId.get("codex-chrome")?.setupUrl).toContain("learn.chatgpt.com");
    expect(byId.get("codex-computer-use")?.fallbackIcon).toContain("computer-use-plugin-icon");
    expect(byId.get("codex-messages")?.fallbackIcon).toBe("/plugin-icons/messages.webp");
    // Computer History has no published mark of its own, so it identifies its
    // provider instead.
    expect(byId.get("codex-computer-history")?.fallbackIcon).toContain("openai.com");
    expect(byId.get("codex-messages")?.setupHint).not.toContain("browser extension");
    // And the steps are numbered and name the plugin the person clicked.
    expect(byId.get("codex-messages")?.setupHint).toContain("1. Install the Codex app");
    expect(byId.get("codex-messages")?.setupHint).toContain("Open Messages once inside Codex");
    // The docs server ships with Codex itself, so the CLI alone is enough.
    expect(byId.get("codex-openai-docs")?.available).toBe(true);
  });

  it("keeps Chrome unavailable when only the Computer Use app is installed", () => {
    const home = makeHome();
    writeExecutable(join(home, CLIENT_RELATIVE));
    const cli = writeCodexCli(home);

    const byId = new Map(
      scanCodexPlugins({ codexHome: home, codexCli: cli }).map((entry) => [entry.id, entry]),
    );

    expect(byId.get("codex-messages")?.available).toBe(true);
    expect(byId.get("codex-chrome")?.available).toBe(false);
  });

  it("resolves the trusted Computer Use wrapper from the newest installed cache version", () => {
    const home = makeHome();
    writeExecutable(join(home, CLIENT_RELATIVE));
    const older = writeComputerUsePlugin(home, "1.0.9", "openai-bundled");
    const newest = writeComputerUsePlugin(home, "1.0.10", "openai-curated-remote");
    const cli = writeCodexCli(home);

    const computerUse = scanCodexPlugins({ codexHome: home, codexCli: cli }).find(
      (entry) => entry.id === "codex-computer-use",
    );

    expect(computerUse?.available).toBe(true);
    expect(computerUse?.appServer?.modulePath).toBe(newest);
    expect(computerUse?.appServer?.modulePath).not.toBe(older);
  });

  it("does not fall back to a stale wrapper when the newest plugin lacks one", () => {
    const home = makeHome();
    writeExecutable(join(home, CLIENT_RELATIVE));
    writeComputerUsePlugin(home, "1.0.9");
    mkdirSync(join(home, "plugins", "cache", "openai-bundled", "computer-use", "1.0.10"), {
      recursive: true,
    });
    const cli = writeCodexCli(home);

    const computerUse = scanCodexPlugins({ codexHome: home, codexCli: cli }).find(
      (entry) => entry.id === "codex-computer-use",
    );

    expect(computerUse?.available).toBe(false);
    expect(computerUse?.appServer?.modulePath).toBeUndefined();
  });

  it("scans cached plugins, resolving command and cwd against the newest version", () => {
    const home = makeHome();
    // Two versions; numeric-aware pick must choose 0.1.10 over 0.1.9.
    writeCachedPlugin(home, {
      name: "sec-scan",
      version: "0.1.9",
      servers: { mcpServers: { "sec-scan": { command: "./scripts/run", args: ["--stdio"] } } },
    });
    const newest = writeCachedPlugin(home, {
      name: "sec-scan",
      version: "0.1.10",
      servers: {
        mcpServers: { "sec-scan": { command: "./scripts/run", args: ["--stdio"], cwd: "." } },
      },
    });
    writeExecutable(join(newest, "scripts", "run"));

    const entries = scanCodexPlugins({ codexHome: home });
    const scanned = entries.find((entry) => entry.id === "codex-sec-scan");

    expect(scanned).toMatchObject({
      name: "sec-scan",
      summary: "sec-scan server",
      available: true,
      slug: "codex_sec_scan",
      source: "scanned",
      command: join(newest, "scripts", "run"),
      cwd: newest,
      args: ["--stdio"],
      env: { CODEX_HOME: home },
    });
  });

  it("reports a scanned plugin whose command is missing as unavailable", () => {
    const home = makeHome();
    writeCachedPlugin(home, {
      name: "ghost",
      version: "1.0.0",
      servers: { mcpServers: { ghost: { command: "./bin/gone" } } },
    });

    const scanned = scanCodexPlugins({ codexHome: home }).find(
      (entry) => entry.id === "codex-ghost",
    );

    expect(scanned?.available).toBe(false);
    expect(scanned?.setupHint).toContain("Install the Codex app");
  });

  it("skips remote servers, curated names, and malformed entries", () => {
    const home = makeHome();
    // Remote (http) server — Executor connects to those directly, no spawn.
    writeCachedPlugin(home, {
      name: "github",
      version: "0.1.6",
      servers: {
        mcpServers: { github: { type: "http", url: "https://api.example.com/mcp/" } },
      },
    });
    // Curated name in the cache — the curated card already covers it.
    writeCachedPlugin(home, {
      name: "messages",
      version: "1.0.0",
      servers: { mcpServers: { messages: { command: "./bin/launcher" } } },
    });
    // Skill-only plugin: no mcpServers in the manifest.
    writeCachedPlugin(home, {
      name: "templates",
      version: "0.1.1",
      manifest: { name: "templates" },
    });
    // Malformed manifest JSON must not break the scan.
    const brokenDir = join(home, "plugins", "cache", "x", "broken", "1.0.0", ".codex-plugin");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "plugin.json"), "{not json");

    const entries = scanCodexPlugins({ codexHome: home });

    expect(entries.filter((entry) => entry.source === "scanned")).toEqual([]);
    // Curated cards are still present (the cache copy of `messages` merged away).
    expect(entries.filter((entry) => entry.id === "codex-messages")).toHaveLength(1);
  });

  it("collapses the same plugin cached under several sources into one entry", () => {
    const home = makeHome();
    const a = writeCachedPlugin(home, {
      source: "openai-curated",
      name: "dup",
      version: "1.0.0",
      servers: { mcpServers: { dup: { command: "./bin/run" } } },
    });
    writeCachedPlugin(home, {
      source: "openai-curated-remote",
      name: "dup",
      version: "1.0.0",
      servers: { mcpServers: { dup: { command: "./bin/run" } } },
    });
    writeExecutable(join(a, "bin", "run"));

    const dups = scanCodexPlugins({ codexHome: home }).filter((entry) => entry.id === "codex-dup");

    expect(dups).toHaveLength(1);
    // The available copy wins over the one whose binary is missing.
    expect(dups[0]?.available).toBe(true);
  });
});
