/**
 * The create-time artifact smoke render, behind a dynamic import.
 *
 * A separate entry from the package root, kept that way now for cost rather
 * than for types: the renderer no longer pulls React into a host's graph at
 * all. It runs the artifact inside a QuickJS sandbox, and everything React
 * needs is prebuilt into the harness bundle that goes in there — so what this
 * module's graph actually contains is the kernel runtime and one large string.
 *
 * That is what unblocked wiring `apps/local`. The old in-process renderer
 * imported the `.tsx` component barrel, which TypeScript resolved eagerly
 * through the dynamic `import()` and dragged the whole React graph (and a
 * duplicate `@types/react`) into the CLI and desktop trees. There is no `.tsx`
 * in this path any more, so every host can afford the check.
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
 * Render an artifact once, in a sandbox, to find out whether it renders — with
 * the harness loaded only when a `create-artifact` call actually arrives.
 *
 * The dynamic `import()` is the point of the wrapper: the harness bundle is a
 * multi-megabyte string constant that a session which only ever calls `execute`
 * should not pay to parse at startup. Bundlers keep it as a separate chunk, so
 * the cost is deferred rather than merely deduplicated.
 *
 * See `./shell/smoke-render` for what a render can and cannot conclude, and why
 * it runs where it does.
 */
export const smokeRenderArtifact = async (code: string): Promise<SmokeRenderResult> => {
  const { smokeRenderArtifact: render } = await import("./shell/smoke-render");
  return render(code);
};
