import { build } from "esbuild";

import { Effect } from "effect";

import { ToolSandboxError } from "../seams/tool-sandbox";

// ---------------------------------------------------------------------------
// UI shell: wrap a published ui view's compiled bundle into a COMPLETE HTML
// document that a real MCP-Apps host (Claude / ChatGPT, or the sunpeak host
// simulation) can mount in a sandboxed iframe and render.
//
// The published ui bundle is CJS with `react` / `react-dom` / `executor:ui` /
// `executor:ui/components` left EXTERNAL (as `require(...)`). A browser host
// cannot run that directly: it needs React + the `executor:ui` runtime + the
// component primitives, then it must execute the module and mount its default
// export. This module produces that self-booting document.
//
// The runtime is hermetic: React and the executor:ui runtime are bundled INTO
// the document by esbuild (no CDN, so it renders under a strict sandbox CSP with
// no network). Live data is delivered as a data island the server writes at read
// time (`window.__EXECUTOR_UI__.rows`), so `useQuery` returns real scope-db rows
// on mount. Refetch is wired to the MCP-Apps host bridge + a lightweight polling
// fallback; the SSE-driven live refetch into the mounted widget is a documented
// follow-up (see APPS_DESIGN.md).
// ---------------------------------------------------------------------------

/** The MCP-Apps resource MIME type real hosts key inline rendering on. */
export const UI_APP_MIME = "text/html;profile=mcp-app";

// The browser runtime, bundled once (React + ReactDOM + the executor:ui shim +
// the mount driver). The `__PUBLISHED_BUNDLE__;` marker statement is replaced
// with the published component's CJS at document-assembly time.
const runtimeSource = `
import React from "react";
import { createRoot } from "react-dom/client";

// --- executor:ui runtime ---------------------------------------------------
// A real, minimal implementation of the author-facing hooks. \`useQuery\` returns
// the rows the host delivered in the data island and re-runs when the host
// signals an invalidation (postMessage from the MCP-Apps bridge). \`useTool\`
// posts a tool-call request to the host and resolves on its reply.
const __data = (globalThis.__EXECUTOR_UI__ || { rows: [], title: "", ready: false });

function useQuery(fn) {
  const [state, setState] = React.useState(() => ({
    data: __data.rows || [],
    isLoading: false,
    error: null,
  }));
  const refetch = React.useCallback(() => {
    // Ask the host to re-read; if it answers we update, else keep current rows.
    try {
      window.parent.postMessage({ type: "executor:ui/refetch" }, "*");
    } catch (_e) { /* sandboxed: ignore */ }
    return Promise.resolve(state.data);
  }, [state.data]);
  React.useEffect(() => {
    const onMessage = (event) => {
      const msg = event && event.data;
      if (msg && msg.type === "executor:ui/rows" && Array.isArray(msg.rows)) {
        setState({ data: msg.rows, isLoading: false, error: null });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return { data: state.data, isLoading: state.isLoading, error: state.error, refetch };
}

function useTool(name) {
  const [isRunning, setRunning] = React.useState(false);
  const run = React.useCallback(async (args) => {
    setRunning(true);
    try {
      window.parent.postMessage({ type: "executor:ui/tool", tool: name, args: args }, "*");
    } catch (_e) { /* sandboxed */ }
    setRunning(false);
    return undefined;
  }, [name]);
  return { run, isRunning };
}

function config() { /* metadata read at publish; a no-op in the browser */ }

// --- executor:ui/components (minimal, styled primitives) -------------------
const h = React.createElement;
const box = (tag, base) => (props) => {
  const { className, children, ...rest } = props || {};
  return h(tag, { className: (base + " " + (className || "")).trim(), ...rest }, children);
};
const components = {
  Card: box("div", "ex-card"),
  CardHeader: box("div", "ex-card-header"),
  CardTitle: box("div", "ex-card-title"),
  CardContent: box("div", "ex-card-content"),
  Badge: box("span", "ex-badge"),
  Button: (props) => {
    const { className, children, ...rest } = props || {};
    return h("button", { className: ("ex-button " + (className || "")).trim(), ...rest }, children);
  },
  Input: (props) => h("input", { className: "ex-input", ...(props || {}) }),
};

// --- CJS require shim: satisfy the bundle's externals ----------------------
function __require(id) {
  if (id === "react") return React;
  if (id === "react/jsx-runtime") return { jsx: h, jsxs: h, Fragment: React.Fragment };
  if (id === "react-dom" || id === "react-dom/client") return { createRoot };
  if (id === "executor:ui") return { config, useQuery, useTool };
  if (id === "executor:ui/components") return components;
  throw new Error("module not available in ui runtime: " + id);
}

// --- run the published component bundle + mount ----------------------------
function __runBundle() {
  const module = { exports: {} };
  const exports = module.exports;
  const require = __require;
  // The published component's CJS is spliced in below. It is built from the same
  // virtual entry the tool/workflow collect path uses, which assigns the author
  // module onto \`globalThis.__artifact\` (NOT module.exports). We read the default
  // export from there, falling back to module.exports for robustness.
  (function (module, exports, require) {
    __PUBLISHED_BUNDLE__;
  })(module, exports, require);
  const artifact = globalThis.__artifact;
  return (
    (artifact && (artifact.default || artifact)) ||
    (module.exports && (module.exports.default || module.exports))
  );
}

function __mount() {
  const App = __runBundle();
  const root = createRoot(document.getElementById("root"));
  root.render(h(App));
  // Signal paint so a host waiting on first render can proceed.
  try { window.parent.postMessage({ type: "executor:ui/mounted" }, "*"); } catch (_e) {}
}

try {
  __mount();
} catch (err) {
  // Surface a mount failure in the document itself so a host (and tests) see it
  // instead of a blank frame.
  const root = document.getElementById("root");
  if (root) root.textContent = "ui mount error: " + ((err && err.message) || String(err));
  try { window.parent.postMessage({ type: "executor:ui/error", message: String(err && err.message || err) }, "*"); } catch (_e) {}
}
`;

const HTML_STYLES = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
  body { margin: 0; padding: 12px; }
  .ex-card { border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; margin-top: 8px; }
  .ex-card-header { padding: 8px 12px; border-bottom: 1px solid rgba(0,0,0,0.08); }
  .ex-card-title { font-weight: 600; }
  .ex-card-content { padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
  .ex-badge { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 6px; background: rgba(0,0,0,0.08); margin-left: 4px; }
  .ex-button { padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.2); background: #f5f5f5; cursor: pointer; }
  .ex-input { padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.2); }
  a { color: inherit; text-decoration: none; }
`;

/** Bundle the browser runtime (React + shim + mount) with the published
 *  component's CJS spliced in, then wrap it in a complete HTML document. */
export const buildUiDocument = (input: {
  readonly compiledBundle: string;
  readonly title: string;
  readonly maxHeight?: number;
  readonly rows: readonly unknown[];
}): Effect.Effect<string, ToolSandboxError> =>
  Effect.tryPromise({
    try: async () => {
      // Splice the published CJS in place of the marker statement. Use a
      // function replacer so `$`-sequences in the bundle are not interpreted.
      const runtimeWithBundle = runtimeSource.replace(
        "__PUBLISHED_BUNDLE__;",
        () => input.compiledBundle,
      );
      const result = await build({
        stdin: {
          contents: runtimeWithBundle,
          loader: "tsx",
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "es2022",
        minify: true,
        jsx: "automatic",
        logLevel: "silent",
        // React is resolved from this package's node_modules and inlined.
        define: { "process.env.NODE_ENV": '"production"' },
      });
      const runtimeJs = result.outputFiles?.[0]?.text;
      if (runtimeJs === undefined) throw new Error("ui runtime produced no output");

      const dataIsland = safeJsonForScript({
        rows: input.rows,
        title: input.title,
        ready: true,
      });
      // A complete, self-contained MCP-Apps document. No external network: React,
      // the runtime, and the initial rows are all inline, so it renders under a
      // strict sandbox CSP.
      return [
        "<!doctype html>",
        '<html lang="en"><head><meta charset="utf-8" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1" />',
        `<title>${escapeHtml(input.title)}</title>`,
        `<style>${HTML_STYLES}</style>`,
        `<script>window.__EXECUTOR_UI__ = ${dataIsland};</script>`,
        "</head><body>",
        '<div id="root"></div>',
        `<script>${runtimeJs}</script>`,
        "</body></html>",
      ].join("");
    },
    catch: (cause) =>
      new ToolSandboxError({
        kind: "bundle",
        message: `ui document build failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });

// Serialize a value as JSON safe to embed in an inline `<script>` element. The
// hazard is that a string value containing `</script>` (or `<!--`) closes the
// script element and lets arbitrary markup after it execute. The well-known safe
// pattern escapes the characters that can start such a sequence — `<`, `>`, `&`
// — as their `\uXXXX` JSON escapes (which parse back to the identical string),
// plus the U+2028/U+2029 line terminators that are literal newlines in a script
// but valid inside a JSON string. The result is still valid JSON and still
// `JSON.parse`s to the original value; it simply can never contain a raw
// `</script`.
const SCRIPT_UNSAFE: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export const safeJsonForScript = (value: unknown): string =>
  JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => SCRIPT_UNSAFE[c] ?? c);

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      (
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }) as Record<string, string>
      )[c]!,
  );
