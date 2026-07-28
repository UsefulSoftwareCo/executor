/**
 * The two Vite plugins this package hands to app builds.
 *
 * `innerRendererPlugin` supplies `virtual:executor-inner-renderer`: the shell
 * renders model-written JSX inside a nested `srcDoc` iframe whose whole program
 * is inlined as a string. That string is the inner renderer, bundled to an IIFE
 * by esbuild — it cannot be a normal import, because it must exist as *source
 * text* to be embedded in the sandboxed frame.
 *
 * `mcpAppsShellAsset` supplies `virtual:executor-mcp-apps-shell-html`: the URL
 * of the BUILT, self-contained shell document, emitted into the app's client
 * assets. The console's artifact page loads that URL into a sandboxed iframe
 * and speaks the MCP-Apps protocol to it, exactly as a real MCP-Apps client
 * does with the `ui://executor/shell.html` resource.
 *
 * Both live here rather than in `@executor-js/vite-plugin` because that package
 * is on the plugin-system kill list, and because esbuild, Vite and the shell
 * entry are all this package's own — resolving them from here needs no
 * cross-package path guessing. Apps that embed the shell add both plugins to
 * their vite config; the standalone shell build uses the inner-renderer one
 * too, so there is one definition of how the inner renderer is built.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** The structural shape of the Vite plugin object, declared locally so this
 *  module imports no Vite types (apps pin their own Vite version). */
export interface InnerRendererVitePlugin {
  readonly name: string;
  readonly enforce?: "pre";
  readonly resolveId: (id: string) => string | undefined;
  readonly load: (id: string) => Promise<string | undefined>;
}

const VIRTUAL_ID = "virtual:executor-inner-renderer";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const innerRendererEntry = (): string =>
  path.resolve(packageRoot, "src/shell/inner-renderer.tsx");

/**
 * Bundle the inner renderer to a self-contained IIFE string.
 *
 * Exported on its own so a build script or test can produce the same bytes the
 * plugin serves without standing up Vite.
 */
export const bundleInnerRenderer = async (): Promise<string> => {
  const result = await build({
    entryPoints: [innerRendererEntry()],
    absWorkingDir: packageRoot,
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
    },
  });

  const js = result.outputFiles[0];
  if (!js) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: Vite plugin hooks report build failures by throwing
    throw new Error("Failed to bundle the MCP-Apps inner renderer.");
  }
  return js.text;
};

/** Add to an app's `plugins` array to make the shell bundleable in that app. */
export const innerRendererPlugin = (): InnerRendererVitePlugin => ({
  name: "executor-inner-renderer-source",
  // `pre` so the virtual id resolves before any generic resolver claims it.
  enforce: "pre",
  resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_ID : undefined),
  load: async (id) => {
    if (id !== RESOLVED_ID) return undefined;
    return `export default ${JSON.stringify(await bundleInnerRenderer())};`;
  },
});

// ---------------------------------------------------------------------------
// The in-frame Tailwind compiler, as source text
// ---------------------------------------------------------------------------

const TAILWIND_VIRTUAL_ID = "virtual:executor-tailwind-browser";
const TAILWIND_RESOLVED_ID = `\0${TAILWIND_VIRTUAL_ID}`;

/**
 * Supply `@tailwindcss/browser`'s bundle as a STRING.
 *
 * The shell inlines it into the sandboxed renderer frame, which compiles the
 * utilities the model's code uses — the build-time stylesheet can only contain
 * classes that existed at build time, and the model's did not. That frame runs
 * under `default-src 'none'` with no `connect-src`, so the compiler cannot be
 * fetched and has to travel as bytes.
 *
 * A plugin rather than an `?raw` import because the package's `exports` map
 * publishes only its module entry, so a deep path into `dist/` fails to
 * resolve. Reading the resolved entry's file is the supported way to its bytes.
 */
export const tailwindBrowserSourcePlugin = (): InnerRendererVitePlugin => ({
  name: "executor-tailwind-browser-source",
  enforce: "pre",
  resolveId: (id) => (id === TAILWIND_VIRTUAL_ID ? TAILWIND_RESOLVED_ID : undefined),
  load: async (id) => {
    if (id !== TAILWIND_RESOLVED_ID) return undefined;
    const fs = await import("node:fs/promises");
    const { createRequire } = await import("node:module");
    const require = createRequire(path.join(packageRoot, "package.json"));
    const entry = require.resolve("@tailwindcss/browser");
    return `export default ${JSON.stringify(await fs.readFile(entry, "utf-8"))};`;
  },
});

// ---------------------------------------------------------------------------
// The built shell document, as an app asset
// ---------------------------------------------------------------------------

const SHELL_VIRTUAL_ID = "virtual:executor-mcp-apps-shell-html";
const SHELL_RESOLVED_ID = `\0${SHELL_VIRTUAL_ID}`;

/** Where `build:shell` writes the self-contained shell document. */
export const mcpAppsShellHtmlPath = (): string => path.resolve(packageRoot, "dist/mcp-app.html");

/**
 * Build the shell document and return its bytes.
 *
 * The shell is its own Vite build (`vite.config.shell.ts`), not an entry of the
 * app build: `vite-plugin-singlefile` inlines every chunk into one document,
 * which is only correct for a build whose sole output is that document. It runs
 * as a CHILD PROCESS rather than an in-process `vite.build()` because the caller
 * is itself a Vite build — nesting two builds in one process has them fight over
 * the singleton plugin state that `@tailwindcss/vite` and `@vitejs/plugin-react`
 * keep, and the shell's own Tailwind scan would then see the host app's sources.
 *
 * Always rebuilds rather than reusing a stale `dist/mcp-app.html`: the document
 * is what the artifact page renders, so serving yesterday's bytes is exactly the
 * class of bug this seam exists to prevent. The build takes about a second.
 */
export const buildMcpAppsShellHtml = async (): Promise<string> => {
  const fs = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");

  await promisify(execFile)(
    process.execPath,
    [
      path.resolve(packageRoot, "node_modules/vite/bin/vite.js"),
      "build",
      "--config",
      "vite.config.shell.ts",
    ],
    { cwd: packageRoot, maxBuffer: 32 * 1024 * 1024 },
  );

  return fs.readFile(mcpAppsShellHtmlPath(), "utf-8");
};

/** The structural shape of the shell-asset plugin — same reasoning as above:
 *  no Vite types cross this module's boundary. */
export interface McpAppsShellAssetVitePlugin {
  readonly name: string;
  readonly enforce?: "pre";
  readonly configResolved: (config: {
    readonly command: "build" | "serve";
    readonly build?: { readonly ssr?: boolean | string };
  }) => void;
  readonly resolveId: (id: string) => string | undefined;
  readonly load: (id: string) => Promise<string | undefined>;
  readonly configureServer: (server: {
    readonly middlewares: {
      use: (
        path: string,
        handler: (
          req: unknown,
          res: {
            setHeader: (name: string, value: string) => void;
            end: (body: string) => void;
          },
          next: () => void,
        ) => void,
      ) => void;
    };
  }) => void;
  /** Rollup calls this with its plugin context as `this` — declared here so the
   *  implementation can reach `emitFile` without casting. */
  readonly generateBundle: (
    this: RollupEmitContext,
    options: unknown,
    bundle: unknown,
    isWrite: boolean,
  ) => Promise<void> | void;
  readonly closeBundle: () => Promise<void>;
}

/** What this plugin needs from the hook context Vite calls it with. */
interface RollupEmitContext {
  readonly emitFile: (file: {
    readonly type: "asset";
    readonly fileName: string;
    readonly source: string;
  }) => void;
  /** Vite's per-hook environment. `consumer` is "client" for the browser build
   *  and "server" for an SSR/worker one. */
  readonly environment?: { readonly config?: { readonly consumer?: string } };
}

/**
 * Serve the built shell document to the app at a stable URL.
 *
 * The artifact page needs the shell as a DOCUMENT, not as modules linked into
 * the console's own bundle — that is the whole point of the fix. So the shell
 * cannot travel through the app's module graph; it has to arrive as a URL the
 * iframe can load, with its own origin-less document scope.
 *
 * Under `serve` the document is built on first request and served from a dev
 * middleware. Under `build` it is emitted into the client output next to the
 * app's other assets. Either way the virtual module exports only the URL, so
 * the 4.5 MB document never enters a JS chunk.
 *
 * Content-hashed so a stale shell can never be served from a cached URL after
 * a rebuild, matching how `workerBundlerArtifact` addresses its own artifacts.
 */
export const mcpAppsShellAsset = (): McpAppsShellAssetVitePlugin => {
  let command: "build" | "serve" = "build";
  let ssr = false;
  let cached: { readonly html: string; readonly url: string } | undefined;

  const load = async (): Promise<{ readonly html: string; readonly url: string }> => {
    if (cached) return cached;
    const html = await buildMcpAppsShellHtml();
    const digest = createHash("sha256").update(html).digest("hex").slice(0, 12);
    cached = { html, url: `/assets/executor-mcp-apps-shell-${digest}.html` };
    return cached;
  };

  return {
    name: "executor-mcp-apps-shell-asset",
    enforce: "pre",
    configResolved(config) {
      command = config.command;
      // Recorded per environment, but ONE plugin instance sees every
      // environment's `configResolved` before any of their bundles are
      // generated — so the last write wins and this cannot be trusted at emit
      // time. `generateBundle` reads Rollup's own output options instead; this
      // only carries the single-environment case, where the two agree.
      ssr = Boolean(config.build?.ssr);
    },
    resolveId: (id) => (id === SHELL_VIRTUAL_ID ? SHELL_RESOLVED_ID : undefined),
    load: async (id) => {
      if (id !== SHELL_RESOLVED_ID) return undefined;
      const { url } = await load();
      return `export const shellHtmlUrl = ${JSON.stringify(url)};\nexport default shellHtmlUrl;\n`;
    },
    configureServer(server) {
      // Dev has no emitted assets directory, so the document is served straight
      // from memory at the same URL the virtual module advertises.
      server.middlewares.use("/assets", (req, res, next) => {
        const url = (req as { url?: string }).url ?? "";
        if (!url.startsWith("/executor-mcp-apps-shell-")) {
          next();
          return;
        }
        void load().then(({ html }) => {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.end(html);
        });
      });
    },
    async generateBundle(_options, _bundle, _isWrite) {
      if (command !== "build") return;

      // Client output only. A multi-environment build (TanStack Start on cloud
      // emits `dist/client` and `dist/server`) runs this hook once per
      // environment, and `dist/server` IS the deployed Worker — emitting 4.5 MB
      // of browser document there would inflate the Worker bundle with
      // something only the browser ever fetches, over the ASSETS binding, from
      // `dist/client`.
      //
      // The hook's own environment is the authority, because it is the only
      // signal that is per-bundle: `configResolved`'s `build.ssr` is recorded
      // once per environment on this shared plugin instance, so by the time any
      // bundle is generated it holds whichever environment resolved last. A
      // single-environment build (selfhost) reports no environment, and falls
      // back to that flag, where the two do agree.
      const consumer = this.environment?.config?.consumer;
      if (consumer === undefined ? ssr : consumer !== "client") return;

      const { html, url } = await load();
      // `emitFile` puts the document through Rollup's own output writer, so it
      // lands in whatever client outDir the app (or its framework plugin)
      // configured — which `process.cwd()`-relative writes get wrong for
      // TanStack Start, where the client build writes to `dist/client`.
      this.emitFile({ type: "asset", fileName: url.replace(/^\//, ""), source: html });
    },
    async closeBundle() {
      cached = undefined;
    },
  };
};
