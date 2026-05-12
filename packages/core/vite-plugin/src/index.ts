// ---------------------------------------------------------------------------
// @executor-js/vite-plugin — wires plugin client bundles into the host's
// Vite build so plugin-contributed pages, widgets, and slot components
// are present in the frontend bundle. The host imports
// `virtual:executor/plugins-client` and gets the list of every loaded
// plugin's `defineClientPlugin(...)` value.
//
// Two sources, concatenated and de-duplicated:
//   1. `executor.config.ts` — static, TS-typed plugin tuple. The plugin
//      Vite-plugin reads each spec's `packageName` and emits an import
//      for `${packageName}/client`.
//   2. `executor.jsonc#plugins` — dynamic, jiti-loaded at server boot.
//      The Vite plugin reads each entry's `package` field directly
//      (no need to import the server module — packageName == entry.package).
//
// Plugins without a `packageName` are SDK-only and contribute nothing to
// the frontend bundle — they're skipped.
//
// HMR: the virtual module is part of Vite's graph. Changing either
// `executor.config.ts` or `executor.jsonc` invalidates it and triggers
// a hot update for plugin-list consumers; adding/removing a plugin
// requires a Vite restart (because the npm dep graph changed).
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import * as jsonc from "jsonc-parser";
import type { Plugin } from "vite";
import type { ExecutorCliConfig } from "@executor-js/sdk";

const VIRTUAL_ID = "virtual:executor/plugins-client";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

const DEFAULT_CONFIG_CANDIDATES = [
  "executor.config.ts",
  "executor.config.js",
  "executor.config.mjs",
  "src/executor.config.ts",
  "src/executor.config.js",
];

const DEFAULT_JSONC_CANDIDATES = ["executor.jsonc", "executor.json"];

const readJsoncPlugins = (path: string): readonly string[] => {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = jsonc.parse(raw) as
      | { plugins?: ReadonlyArray<{ package?: string }> }
      | undefined;
    const entries = parsed?.plugins ?? [];
    return entries.map((e) => e.package).filter((p): p is string => !!p);
  } catch {
    return [];
  }
};

const tryResolveClient = (packageName: string, fromDir: string): string | null => {
  const require = createRequire(resolvePath(fromDir, "_anchor.js"));
  try {
    return require.resolve(`${packageName}/client`);
  } catch {
    return null;
  }
};

interface ExecutorVitePluginOptions {
  /**
   * Path to the executor config file. Resolved relative to the Vite
   * project root if not absolute. Defaults to the first match of
   * `executor.config.ts` / `.js` / `.mjs` (with a fallback under
   * `src/`).
   */
  readonly configPath?: string;
  /**
   * Path to the executor jsonc manifest. Resolved relative to the Vite
   * project root if not absolute. Defaults to `executor.jsonc`.
   */
  readonly jsoncPath?: string;
}

export default function executorVitePlugin(options: ExecutorVitePluginOptions = {}): Plugin {
  let projectRoot: string = process.cwd();
  let resolvedConfigPath: string | null = null;
  let resolvedJsoncPath: string | null = null;
  let cachedSource: string | null = null;

  const resolveConfigPath = (): string | null => {
    if (resolvedConfigPath) return resolvedConfigPath;
    const candidates = options.configPath ? [options.configPath] : DEFAULT_CONFIG_CANDIDATES;
    for (const candidate of candidates) {
      const abs = isAbsolute(candidate) ? candidate : resolvePath(projectRoot, candidate);
      if (existsSync(abs)) {
        resolvedConfigPath = abs;
        return abs;
      }
    }
    return null;
  };

  const resolveJsoncPath = (): string | null => {
    if (resolvedJsoncPath) return resolvedJsoncPath;
    const candidates = options.jsoncPath ? [options.jsoncPath] : DEFAULT_JSONC_CANDIDATES;
    for (const candidate of candidates) {
      const abs = isAbsolute(candidate) ? candidate : resolvePath(projectRoot, candidate);
      if (existsSync(abs)) {
        resolvedJsoncPath = abs;
        return abs;
      }
    }
    return null;
  };

  const loadVirtualSource = async (): Promise<string> => {
    if (cachedSource !== null) return cachedSource;

    const configPath = resolveConfigPath();
    const jsoncPath = resolveJsoncPath();
    const fromDir = configPath ? dirname(configPath) : projectRoot;

    // Collect plugin entries in priority order: static config first,
    // jsonc second. De-duplicate by package name — if both list the
    // same plugin, only one import is emitted. (Static wins for the
    // ordering of `plugins` array, which matters for nav order.)
    //
    // `clientConfig` only flows in via the static config path: it
    // lives on the runtime `PluginSpec` returned by
    // `definePlugin(...)`, which is only available when we jiti-load
    // the TS module. The jsonc path carries package names only.
    const entries: Array<{ readonly pkg: string; readonly clientConfig?: unknown }> = [];
    const seen = new Set<string>();

    if (configPath) {
      // jiti is a dev dep of consumers; importing dynamically lets the
      // plugin be lazy-loaded and avoids a hard requirement when the
      // host doesn't actually use plugins yet.
      const { createJiti } = await import("jiti");
      const jiti = createJiti(pathToFileURL(configPath).href, {
        interopDefault: true,
        moduleCache: false,
      });
      const mod = (await jiti.import(configPath)) as
        | { default?: ExecutorCliConfig }
        | ExecutorCliConfig;
      const config = ("default" in mod && mod.default ? mod.default : mod) as ExecutorCliConfig;
      for (const spec of config.plugins()) {
        if (!spec.packageName) continue;
        if (seen.has(spec.packageName)) continue;
        seen.add(spec.packageName);
        const clientConfig = (spec as { clientConfig?: unknown }).clientConfig;
        entries.push({
          pkg: spec.packageName,
          ...(clientConfig !== undefined ? { clientConfig } : {}),
        });
      }
    }

    if (jsoncPath) {
      for (const pkg of readJsoncPlugins(jsoncPath)) {
        if (seen.has(pkg)) continue;
        seen.add(pkg);
        entries.push({ pkg });
      }
    }

    const lines: string[] = [];
    const exportExpressions: string[] = [];

    for (const entry of entries) {
      const resolved = tryResolveClient(entry.pkg, fromDir);
      if (!resolved) {
        // package was listed but didn't resolve. Likely culprits:
        // a typo, a package that hasn't published `./client` in its
        // exports map yet, or the package isn't installed. Warn
        // loudly so the dev sees their plugin's UI is missing instead
        // of silently shipping a host without it.
        console.warn(
          `[@executor-js/vite-plugin] plugin package "${entry.pkg}" listed but ` +
            `${entry.pkg}/client could not be resolved from ${fromDir}. The ` +
            `plugin's UI will not be bundled. Check that the package is ` +
            `installed and exports a \`./client\` subpath in its ` +
            `package.json.`,
        );
        continue;
      }
      const ident = `__executor_plugin_${exportExpressions.length}`;
      // Emit the absolute file path rather than `${pkg}/client`. Vite
      // resolves bare specifiers from its `root`, which for hosts like
      // apps/local is `packages/app/` — a location that doesn't see
      // plugin packages installed under the consumer's node_modules.
      // Resolving here (from the consumer's executor.config dir) and
      // emitting the absolute path bypasses Vite's node_modules walk
      // entirely while still honoring each plugin's `exports./client`
      // conditions (Node's resolver handles those above).
      lines.push(`import ${ident} from ${JSON.stringify(pathToFileURL(resolved).href)};`);
      // Plugins that surface a `clientConfig` default-export a factory
      // `(config?) => ClientPluginSpec`; everyone else default-exports
      // a bare `ClientPluginSpec` value. We emit a call only when we
      // have config to thread through, so existing plugins need no
      // changes to keep working.
      exportExpressions.push(
        entry.clientConfig !== undefined
          ? `${ident}(${JSON.stringify(entry.clientConfig)})`
          : ident,
      );
    }

    cachedSource =
      `${lines.join("\n")}\n` + `export const plugins = [${exportExpressions.join(", ")}];\n`;
    return cachedSource;
  };

  return {
    name: "@executor-js/vite-plugin",
    enforce: "pre",
    configResolved(config) {
      projectRoot = config.root;
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return undefined;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined;
      return loadVirtualSource();
    },
    handleHotUpdate(ctx) {
      const configPath = resolveConfigPath();
      const jsoncPath = resolveJsoncPath();
      const isWatched =
        (configPath && ctx.file === configPath) || (jsoncPath && ctx.file === jsoncPath);
      if (!isWatched) return undefined;
      cachedSource = null;
      const mod = ctx.server.moduleGraph.getModuleById(RESOLVED_ID);
      return mod ? [mod] : undefined;
    },
  };
}

// Consumers wanting strong typing for `virtual:executor/plugins-client`
// should add the following to a `vite-env.d.ts` (or any ambient `.d.ts`):
//
//   declare module "virtual:executor/plugins-client" {
//     import type { ClientPluginSpec } from "@executor-js/sdk/client";
//     export const plugins: readonly ClientPluginSpec[];
//   }
//
// We don't ship the augmentation from this package because TS module
// augmentation can only target modules TS already resolves, and Vite
// virtual ids aren't resolvable by the type checker on their own.
