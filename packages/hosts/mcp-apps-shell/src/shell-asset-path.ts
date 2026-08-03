/**
 * The names the built shell document travels under, shared by the build-time
 * emitter (`./vite`) and the runtime loaders (`./shell-html`, `./worker`).
 *
 * In its own module so runtime loaders can import the constants without
 * dragging in the build-time plugin machinery (esbuild, child-process Vite).
 */

/**
 * Where `mcpAppsShellAsset` emits the STABLE-NAMED copy of the built shell
 * document, alongside the content-hashed one.
 *
 * The hashed name exists for browsers: the console's artifact page loads the
 * shell by URL, and a content hash is what lets that URL be cached forever. A
 * Worker serving the `ui://executor/shell.html` MCP resource has the opposite
 * problem — it fetches the document server-side through the ASSETS binding,
 * at runtime, from a bundle that cannot know the hash the client build
 * produced. A second copy at a name both sides agree on ahead of time is the
 * seam. No staleness risk: the binding serves the current deployment's
 * assets, not a browser cache keyed on the URL.
 */
export const MCP_APPS_SHELL_STABLE_ASSET_PATH = "/assets/executor-mcp-apps-shell-stable.html";

/**
 * A fragment every built shell document contains (the `<meta>` in
 * `src/shell/mcp-app.html`), and no other document does.
 *
 * Exists because a fetch through a Workers ASSETS binding cannot be trusted
 * by status alone: with `not_found_handling: "single-page-application"`
 * (host-cloudflare), a miss returns the console's `index.html` with a 200.
 * Serving THAT as the shell resource would be the exact silent-hang failure
 * this seam exists to kill — the client loads a real document that never
 * speaks the MCP-Apps protocol. Loaders verify the marker and fail loudly.
 */
export const MCP_APPS_SHELL_DOCUMENT_MARKER = 'name="executor-mcp-apps-shell"';
