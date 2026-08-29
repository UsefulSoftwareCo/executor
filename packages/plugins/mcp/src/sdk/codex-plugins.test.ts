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
// The three curated plugins must always be reported — available when the
// client binary exists, with a setup hint when it does not — and the cache
// scan must pick each plugin's newest version, resolve its relative command
// and cwd against that version dir, skip remote (http) servers, and never
// fail the whole scan on a malformed entry.
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
    const cli = writeCodexCli(home);

    const entries = scanCodexPlugins({ codexHome: home, codexCli: cli });
    const curated = entries.filter((entry) => entry.source === "curated");

    expect(curated.map((entry) => entry.id)).toEqual([
      "codex-messages",
      "codex-computer-use",
      "codex-computer-history",
    ]);
    for (const entry of curated) {
      expect(entry.available).toBe(true);
      // Curated plugins go through the app-server bridge — its service only
      // honours Codex host sessions, so the client binary is never spawned.
      expect(entry.command).toBe(cli);
      expect(entry.args).toEqual(["app-server"]);
      expect(entry.env).toEqual({ CODEX_HOME: home });
      expect(entry.setupHint).toBeUndefined();
    }
    expect(curated.map((entry) => entry.appServer?.server)).toEqual([
      "messages",
      "computer-use",
      "computer-history",
    ]);
  });

  it("reports the curated plugins with a setup hint when Codex is not installed", () => {
    const home = makeHome();

    const entries = scanCodexPlugins({ codexHome: home, codexCli: join(home, "bin", "codex") });
    const curated = entries.filter((entry) => entry.source === "curated");

    expect(curated).toHaveLength(3);
    for (const entry of curated) {
      expect(entry.available).toBe(false);
      expect(entry.setupHint).toContain("Install the Codex app");
    }
  });

  it("stays unavailable when the CLI exists but the Computer Use app is missing", () => {
    const home = makeHome();
    const cli = writeCodexCli(home);

    const curated = scanCodexPlugins({ codexHome: home, codexCli: cli }).filter(
      (entry) => entry.source === "curated",
    );

    // `codex app-server` would start, but no `messages`/`computer-use` server
    // exists without the plugin app — so the card must not claim readiness.
    for (const entry of curated) expect(entry.available).toBe(false);
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
