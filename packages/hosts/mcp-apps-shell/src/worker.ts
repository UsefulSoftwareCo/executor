// The ambient declaration for `virtual:executor-mcp-apps-shell-dev-html`
// travels with this module into the Workers hosts that import it (their
// tsconfig `include` covers only their own sources) — same trick as
// `shell/artifact-renderer.tsx` and its `shell-html-url.d.ts`.
/// <reference path="./shell-dev-html.d.ts" />

/**
 * The shell loader for Workers hosts, where `loadMcpAppsShellHtml`'s
 * `fs.readFile` can never succeed: a deployed isolate has no filesystem, so
 * the document arrives the way #1378 delivers the worker-bundler artifact —
 * emitted into the client assets at build time and fetched through the
 * `ASSETS` binding at runtime.
 *
 * Kept free of the shell's own module graph (React, Recharts, Tailwind): this
 * entry ships only a fetch and two constants, so a Worker can import it
 * without dragging browser code into its bundle.
 */

import {
  MCP_APPS_SHELL_DOCUMENT_MARKER,
  MCP_APPS_SHELL_STABLE_ASSET_PATH,
} from "./shell-asset-path";

/** The structural shape of a Workers static-assets binding (`env.ASSETS`). */
export interface ShellAssetsBinding {
  readonly fetch: (request: Request) => Promise<Response>;
}

/**
 * Build a `loadAppShellHtml` over the `ASSETS` binding.
 *
 * `devShellHtml` carries the document inline during `vite dev`, where no
 * assets have been emitted yet: pass a thunk that dynamically imports
 * `virtual:executor-mcp-apps-shell-dev-html` — the built shell under `serve`,
 * `undefined` under `build`. A THUNK, not the value: under `serve` that
 * virtual module builds the multi-megabyte shell in a child process, a cost
 * only the first artifact resource read should pay, never dev-server
 * startup. Same dual-shape seam #1378 uses for the worker-bundler artifact.
 *
 * Failure REJECTS, deliberately, on either a non-OK response or a document
 * that is not the shell. The second check is load-bearing: under SPA
 * not-found handling the binding answers a miss with the console's
 * `index.html` and a 200, and serving THAT as the `ui://` resource is the
 * silent every-client-hangs failure this seam exists to kill — the client
 * loads a real document that never starts the MCP-Apps handshake. A rejected
 * read surfaces as a JSON-RPC error naming the missing asset instead.
 */
export const makeAssetsShellHtmlLoader = (input: {
  readonly assets: ShellAssetsBinding;
  readonly devShellHtml?: () => Promise<string | undefined>;
}): (() => Promise<string>) => {
  let cache: string | undefined;
  return async () => {
    if (cache !== undefined) return cache;
    const devHtml = await input.devShellHtml?.();
    if (devHtml !== undefined) {
      cache = devHtml;
      return cache;
    }
    const response = await input.assets.fetch(
      new Request(new URL(MCP_APPS_SHELL_STABLE_ASSET_PATH, "https://assets.local")),
    );
    const html = response.ok ? await response.text() : undefined;
    if (html === undefined || !html.includes(MCP_APPS_SHELL_DOCUMENT_MARKER)) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a Worker without the emitted shell asset must fail the resource read loudly; any other document served as the shell hangs every MCP-Apps client silently
      throw new Error(
        `MCP-Apps shell asset ${MCP_APPS_SHELL_STABLE_ASSET_PATH} is missing from this deployment's ` +
          `static assets (${html === undefined ? `ASSETS fetch returned ${response.status}` : "the fetch returned a different document"}). ` +
          "The app build emits it via mcpAppsShellAsset (@executor-js/mcp-apps-shell/vite); rebuild and redeploy.",
      );
    }
    cache = html;
    return cache;
  };
};
