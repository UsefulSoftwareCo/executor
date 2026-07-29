/**
 * The create-time artifact smoke render, behind a dynamic import.
 *
 * This is a SEPARATE ENTRY from the package root on purpose. The root entry
 * promises that importing it drags no React into the consumer's graph — the MCP
 * host, the CLI, self-host and Cloudflare all rely on that, and TypeScript
 * resolves a dynamic `import()` just as eagerly as a static one, so putting
 * this function in `index.ts` would break the promise for every one of them
 * even though none of them evaluates it.
 *
 * Hosts that WANT the check import this path and pass the function to the MCP
 * host's `smokeRenderArtifact` seam; the rest import the root and never see the
 * renderer at all.
 */

/**
 * What a create-time trial render concluded.
 *
 * Structural, and declared here rather than re-exported from
 * `./shell/smoke-render`, so a host can hold the TYPE without resolving the
 * renderer's `.tsx` module graph.
 */
export type SmokeRenderResult =
  | { readonly status: "ok" }
  | { readonly status: "failed"; readonly message: string; readonly componentStack?: string };

/**
 * Render an artifact once, server-side, to find out whether it renders — with
 * React loaded only when a `create-artifact` call actually arrives.
 *
 * The dynamic `import()` is the point of the wrapper: React, react-dom/server
 * and the component barrel are several hundred kilobytes that a session which
 * only ever calls `execute` should not pay for at startup. Bundlers keep it as
 * a separate chunk, so the cost is deferred rather than merely deduplicated.
 *
 * See `./shell/smoke-render` for what a render can and cannot conclude.
 */
export const smokeRenderArtifact = async (code: string): Promise<SmokeRenderResult> => {
  const { smokeRenderArtifact: render } = await import("./shell/smoke-render");
  return render(code);
};
