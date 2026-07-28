/**
 * The Vite plugin that supplies `virtual:executor-inner-renderer`.
 *
 * The shell renders model-written JSX inside a nested `srcDoc` iframe whose
 * whole program is inlined as a string. That string is the inner renderer,
 * bundled to an IIFE by esbuild — it cannot be a normal import, because it must
 * exist as *source text* to be embedded in the sandboxed frame.
 *
 * It lives here rather than in `@executor-js/vite-plugin` because that package
 * is on the plugin-system kill list, and because esbuild and the renderer entry
 * are both this package's own — resolving them from here needs no cross-package
 * path guessing. Apps that bundle the shell into their SPA add this plugin to
 * their vite config; the standalone shell build uses it too, so there is one
 * definition of how the inner renderer is built.
 */

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
