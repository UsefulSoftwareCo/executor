// ---------------------------------------------------------------------------
// Codex plugin discovery — surface locally installed OpenAI Codex plugins that
// ship a stdio MCP server as one-click stdio presets.
//
// A Codex plugin is a directory under `$CODEX_HOME/plugins/cache/<source>/
// <name>/<version>/` whose `.codex-plugin/plugin.json` manifest points at an
// `.mcp.json` describing how to spawn its server. The binaries are OpenAI's,
// installed and licensed through the user's own Codex install — nothing here
// bundles or downloads them; this module only READS what is already on disk
// and reports whether each server's command exists.
//
// Node-only (fs/os): reached exclusively through a dynamic import in the
// plugin extension (mirroring `stdio-connector.ts`'s isolation), never from a
// barrel, so remote-only bundles and workerd never evaluate it.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Option, Schema } from "effect";

import {
  CURATED_CODEX_PLUGINS,
  setupHint,
  setupUrl,
  type CuratedCodexPlugin,
} from "./codex-plugin-presets";

export interface CodexPluginEntry {
  /** Stable card id, e.g. `codex-messages`. */
  readonly id: string;
  readonly name: string;
  /** Executor's own wording — manifests' long-form copy stays on disk. */
  readonly summary: string;
  /** Whether the server's command exists (and Codex itself is installed). */
  readonly available: boolean;
  /** Suggested integration slug, e.g. `codex_messages`. */
  readonly slug: string;
  readonly source: "curated" | "scanned";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Non-interactive env the spawn needs (currently only CODEX_HOME). */
  readonly env?: Readonly<Record<string, string>>;
  /** Present on curated entries: the spawn is `codex app-server` and the
   *  connector bridges MCP to it in process, calling tools on this named
   *  server inside Codex. See `appserver-connector.ts`. */
  readonly appServer?: {
    readonly server: string;
    readonly surface?: "sky" | "browser";
    readonly modulePath?: string;
  };
  /** Shown when `available` is false: the ordered steps, and where to go. */
  readonly setupHint?: string;
  readonly setupUrl?: string;
  /** Public image for this plugin, for machines with no local install. */
  readonly fallbackIcon?: string;
  /** The plugin's own icon from its local install, as a data URI. Read at
   *  runtime from the user's disk — never shipped with executor. */
  readonly icon?: string;
  /** The plugin's own display metadata from its local manifest, so the add
   *  screen can mirror how the plugin presents itself in Codex. */
  readonly displayName?: string;
  readonly tagline?: string;
  readonly description?: string;
}

/** The Codex Computer Use client binary — the shared "Codex Computer Use"
 *  app that implements every curated plugin. Not spawned any more (its
 *  service refuses tool calls from non-Codex hosts; the app-server bridge is
 *  the working path) but still the install marker: when it is absent the
 *  plugins are not installed and the bridge would find no such server. */
const clientBinaryPath = (codexHome: string): string =>
  path.join(
    codexHome,
    "computer-use",
    "Codex Computer Use.app",
    "Contents",
    "SharedSupport",
    "SkyComputerUseClient.app",
    "Contents",
    "MacOS",
    "SkyComputerUseClient",
  );

/** The Chrome plugin's bundled browser client — the module the projected
 *  browser surface imports inside `node_repl`.
 *
 *  Reached through the `latest` symlink Codex maintains beside the versioned
 *  directories, so a plugin update does not strand the stored path. Same
 *  reasoning as pointing Computer Use at the unversioned client binary. */
const browserClientPath = (codexHome: string): string =>
  path.join(
    codexHome,
    "plugins",
    "cache",
    "openai-bundled",
    "chrome",
    "latest",
    "scripts",
    "browser-client.mjs",
  );

const CURATED_PLUGIN_NAMES: ReadonlySet<string> = new Set(
  CURATED_CODEX_PLUGINS.map((c) => c.pluginName),
);

/** The `codex` CLI the app-server bridge spawns. PATH first (the local
 *  executor server usually inherits the user's shell PATH), then the common
 *  install locations for launch contexts that do not. */
const resolveCodexCli = (codexCli?: string): string | undefined => {
  if (codexCli !== undefined) return isExecutableFile(codexCli) ? codexCli : undefined;
  const dirs = [
    ...(process.env["PATH"] ?? "").split(path.delimiter),
    path.join(os.homedir(), ".bun", "bin"),
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, "codex");
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Manifest shapes — only the fields discovery needs. Everything else in the
// manifest is OpenAI's and stays unread.
// ---------------------------------------------------------------------------

const PluginManifest = Schema.Struct({
  name: Schema.String,
  mcpServers: Schema.optional(Schema.Unknown),
  interface: Schema.optional(
    Schema.Struct({
      displayName: Schema.optional(Schema.String),
      shortDescription: Schema.optional(Schema.String),
      longDescription: Schema.optional(Schema.String),
      logo: Schema.optional(Schema.String),
    }),
  ),
  description: Schema.optional(Schema.String),
});

const McpServerSpec = Schema.Struct({
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});

const McpServersFile = Schema.Struct({
  mcpServers: Schema.Record(Schema.String, McpServerSpec),
});

const decodeManifestJson = Schema.decodeUnknownOption(Schema.fromJsonString(PluginManifest));
const decodeServersFileJson = Schema.decodeUnknownOption(Schema.fromJsonString(McpServersFile));
const decodeServersFile = Schema.decodeUnknownOption(McpServersFile);

// ---------------------------------------------------------------------------
// fs helpers — every call is best-effort: a missing or malformed entry means
// "not a discoverable plugin", never a failure of the whole scan.
// ---------------------------------------------------------------------------

const tryOrElse = <A>(evaluate: () => A, orElse: A): A => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: every fs read here is best-effort; a missing or unreadable entry is "not discoverable", not an error
  try {
    return evaluate();
  } catch {
    return orElse;
  }
};

const listDirs = (dir: string): readonly string[] =>
  tryOrElse(
    () =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    [],
  );

const readText = (file: string): string | undefined =>
  tryOrElse(() => fs.readFileSync(file, "utf-8"), undefined);

const isReadableFile = (file: string): boolean =>
  tryOrElse(() => fs.statSync(file).isFile(), false);

const isExecutableFile = (file: string): boolean =>
  tryOrElse(() => {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  }, false);

/** Numeric-aware descending compare so `1.0.10 > 1.0.9` and date-like builds
 *  (`26.825.32147`) order correctly. */
const versionPart = (parts: readonly number[], index: number): number => {
  const value = parts[index];
  return value === undefined || Number.isNaN(value) ? -1 : value;
};

const compareVersionsDesc = (a: string, b: string): number => {
  const as = a.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const bs = b.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const av = versionPart(as, i);
    const bv = versionPart(bs, i);
    if (av !== bv) return bv - av;
  }
  return b.localeCompare(a);
};

const sanitizeSlug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const sanitizeId = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Bound on inlined icon bytes. The bundled icons run 100KB–1MB; anything
 *  past this is not worth inlining into a list response for a 20px avatar. */
const MAX_ICON_BYTES = 1_000_000;

const ICON_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** The plugin's own icon as a data URI, read from the user's local install. */
const readIconDataUri = (file: string): string | undefined =>
  tryOrElse(() => {
    const mime = ICON_MIME[path.extname(file).toLowerCase()];
    if (mime === undefined) return undefined;
    if (fs.statSync(file).size > MAX_ICON_BYTES) return undefined;
    return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
  }, undefined);

interface CodexPluginDisplay {
  readonly icon?: string;
  readonly displayName?: string;
  readonly tagline?: string;
  readonly description?: string;
}

/** Display metadata (icon, names, descriptions) for a curated plugin from its
 *  cache entry (any source, newest version) — how the plugin presents itself
 *  in Codex. The curated SPAWN target is the stable client binary, but this
 *  metadata only exists in the cache; absent cache, the curated card falls
 *  back to executor's own wording. */
const curatedDisplayMetadata = (codexHome: string, pluginName: string): CodexPluginDisplay => {
  const cacheDir = path.join(codexHome, "plugins", "cache");
  for (const sourceName of listDirs(cacheDir)) {
    const pluginDir = path.join(cacheDir, sourceName, pluginName);
    const version = [...listDirs(pluginDir)].sort(compareVersionsDesc)[0];
    if (version === undefined) continue;
    const versionDir = path.join(pluginDir, version);
    const manifest = Option.getOrUndefined(
      decodeManifestJson(readText(path.join(versionDir, ".codex-plugin", "plugin.json"))),
    );
    if (manifest === undefined) continue;
    const logo = manifest.interface?.logo;
    const icon = logo === undefined ? undefined : readIconDataUri(path.resolve(versionDir, logo));
    return {
      ...(icon === undefined ? {} : { icon }),
      ...(manifest.interface?.displayName === undefined
        ? {}
        : { displayName: manifest.interface.displayName }),
      ...(manifest.interface?.shortDescription === undefined
        ? {}
        : { tagline: manifest.interface.shortDescription }),
      ...(manifest.interface?.longDescription === undefined
        ? {}
        : { description: manifest.interface.longDescription }),
    };
  }
  return {};
};

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

const scanCachedPlugin = (
  codexHome: string,
  pluginDir: string,
  pluginName: string,
): readonly CodexPluginEntry[] => {
  const versions = [...listDirs(pluginDir)].sort(compareVersionsDesc);
  const version = versions[0];
  if (version === undefined) return [];
  const versionDir = path.join(pluginDir, version);

  const manifest = Option.getOrUndefined(
    decodeManifestJson(readText(path.join(versionDir, ".codex-plugin", "plugin.json"))),
  );
  if (manifest?.mcpServers === undefined) return [];

  // `mcpServers` is a relative path to an `.mcp.json` in every known manifest;
  // tolerate an inline object of the same shape.
  const servers = Option.getOrUndefined(
    typeof manifest.mcpServers === "string"
      ? decodeServersFileJson(readText(path.resolve(versionDir, manifest.mcpServers)))
      : decodeServersFile({ mcpServers: manifest.mcpServers }),
  );
  if (servers === undefined) return [];

  const displayName = manifest.interface?.displayName ?? manifest.name;
  const summary =
    manifest.interface?.shortDescription ??
    manifest.description?.split("\n")[0] ??
    `Local MCP server from the Codex plugin "${manifest.name}".`;
  const icon =
    manifest.interface?.logo === undefined
      ? undefined
      : readIconDataUri(path.resolve(versionDir, manifest.interface.logo));
  const display: CodexPluginDisplay = {
    ...(icon === undefined ? {} : { icon }),
    ...(manifest.interface?.displayName === undefined
      ? {}
      : { displayName: manifest.interface.displayName }),
    ...(manifest.interface?.shortDescription === undefined
      ? {}
      : { tagline: manifest.interface.shortDescription }),
    ...(manifest.interface?.longDescription === undefined
      ? {}
      : { description: manifest.interface.longDescription }),
  };

  const localServers = Object.entries(servers.mcpServers).flatMap(([serverKey, spec]) =>
    spec.command !== undefined && spec.type !== "http" && spec.url === undefined
      ? [{ serverKey, command: spec.command, args: spec.args, cwd: spec.cwd }]
      : [],
  );

  return localServers.map(({ serverKey, ...spec }) => {
    // Manifest paths are relative to the versioned plugin dir. The versioned
    // dir moves on plugin updates — the connection health check surfaces that
    // as "command missing" and the card re-adds against the new path.
    const command = path.resolve(versionDir, spec.command);
    const cwd = path.resolve(versionDir, spec.cwd ?? ".");
    const available = isExecutableFile(command);
    const idSuffix = localServers.length > 1 ? `-${sanitizeId(serverKey)}` : "";
    return {
      id: `codex-${sanitizeId(pluginName)}${idSuffix}`,
      name: localServers.length > 1 ? `${displayName} — ${serverKey}` : displayName,
      summary,
      available,
      slug: `codex_${sanitizeSlug(pluginName)}${idSuffix.replace(/-/g, "_")}`,
      source: "scanned" as const,
      command,
      args: spec.args === undefined ? [] : [...spec.args],
      cwd,
      // Only CODEX_HOME travels: the manifests' wider `env_vars` lists name
      // host variables whose VALUES would have to be copied out of this
      // process's environment sight-unseen. A user can declare more env on
      // the integration after adding it.
      env: { CODEX_HOME: codexHome },
      ...(available ? {} : { setupHint: setupHint("codex", displayName) }),
      ...display,
    };
  });
};

/**
 * Discover locally installed Codex plugins that expose a stdio MCP server.
 *
 * The three plugins implemented by the shared "Codex Computer Use" app are
 * curated: they are always listed (so the integration is discoverable on a
 * machine without Codex) and they are reached through the `codex app-server`
 * bridge — their service only honours tool calls from a Codex host session,
 * so a direct client spawn can list tools but never call them. Everything
 * else found in the plugin cache with a local-command MCP server is reported
 * as scanned and spawned directly.
 */
export const scanCodexPlugins = (options?: {
  readonly codexHome?: string;
  /** Explicit `codex` CLI path (tests); default resolves PATH + fallbacks. */
  readonly codexCli?: string;
}): readonly CodexPluginEntry[] => {
  const codexHome =
    options?.codexHome ?? process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex");

  const codexCli = resolveCodexCli(options?.codexCli);
  const computerUseApp = isExecutableFile(clientBinaryPath(codexHome));
  const browserClient = browserClientPath(codexHome);
  const chromePlugin = isReadableFile(browserClient);

  /** Each curated card states what it needs; the `codex` CLI is required by
   *  all of them because every one is reached through `codex app-server`. */
  const requirementMet: Record<CuratedCodexPlugin["requires"], boolean> = {
    "computer-use-app": computerUseApp,
    "chrome-plugin": chromePlugin,
    codex: true,
  };

  const curated: readonly CodexPluginEntry[] = CURATED_CODEX_PLUGINS.map((entry) => {
    const display = curatedDisplayMetadata(codexHome, entry.pluginName);
    const available = codexCli !== undefined && requirementMet[entry.requires];
    return {
      id: entry.id,
      name: entry.name,
      summary: entry.summary,
      available,
      slug: entry.slug,
      source: "curated" as const,
      command: codexCli ?? "codex",
      args: ["app-server"],
      env: { CODEX_HOME: codexHome },
      appServer: {
        server: entry.server,
        ...(entry.surface === undefined ? {} : { surface: entry.surface }),
        ...(entry.surface === "browser" ? { modulePath: browserClient } : {}),
      },
      ...(available
        ? {}
        : { setupHint: setupHint(entry.requires, entry.name), setupUrl: setupUrl(entry.requires) }),
      fallbackIcon: entry.publicIcon ?? "https://integrations.sh/logo/openai.com",
      ...display,
    };
  });

  const cacheDir = path.join(codexHome, "plugins", "cache");
  const scanned = listDirs(cacheDir).flatMap((sourceName) => {
    const sourceDir = path.join(cacheDir, sourceName);
    return listDirs(sourceDir)
      .filter((pluginName) => !CURATED_PLUGIN_NAMES.has(pluginName))
      .flatMap((pluginName) =>
        scanCachedPlugin(codexHome, path.join(sourceDir, pluginName), pluginName),
      );
  });

  // One card per id: the same plugin can appear under several cache sources
  // (e.g. a curated and a remote copy); the first (available-first) entry wins.
  const byId = new Map<string, CodexPluginEntry>();
  for (const entry of [...scanned].sort((a, b) => Number(b.available) - Number(a.available))) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }

  return [...curated, ...byId.values()];
};
