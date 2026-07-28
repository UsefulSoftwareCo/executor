import * as React from "react";

// ---------------------------------------------------------------------------
// The seam between the artifact page and the MCP-Apps shell that renders it.
//
// The shell (`@executor-js/mcp-apps-shell`) compiles model-written JSX and runs
// it inside a sandboxed iframe. It cannot be imported here: the shell already
// depends on THIS package for its shadcn component barrel, and turbo rejects
// the resulting package cycle outright (it errors, it does not warn). So the
// dependency is inverted the way the rest of the console does it — this package
// declares the contract, and the app composition roots (`apps/*`, which already
// depend on both) provide the implementation at startup.
//
// A host that never registers a renderer still gets a working artifacts list
// and a detail page that explains the artifact cannot be rendered here, rather
// than a crash — the same graceful-degradation rule the shared console follows
// for any host-specific capability.
//
// The seam carries a LOADER, not a component. The shell is browser-only by
// nature: it imports `@tailwindcss/browser`, which builds a `<style>` element
// at import scope, and it harvests `document.styleSheets` to seed the sandboxed
// iframe. Under SSR (cloud is TanStack Start) a static import of the shell puts
// that module in the server graph and every document request dies with
// `ReferenceError: document is not defined` before a component ever renders.
// Keeping the seam async means the composition roots hand over a `() =>
// import(...)` that only ever runs in the browser, so the shell's own code stays
// honestly browser-only instead of being polluted with `typeof document` guards.
// ---------------------------------------------------------------------------

/** What the page hands the shell: the stored source, and the live host. */
export interface ArtifactRendererProps {
  /** The artifact's stored JSX source. */
  readonly code: string;
  /** HTTP-backed MCP host — see `createHttpShellHost` in `./shell-host`. */
  readonly host: unknown;
}

export type ArtifactRenderer = React.ComponentType<ArtifactRendererProps>;

/**
 * Resolves the renderer on demand, in the browser only. Apps pass a dynamic
 * `import()`; the module is never touched during SSR.
 */
export type ArtifactRendererLoader = () => Promise<{ readonly default: ArtifactRenderer }>;

const ArtifactRendererContext = React.createContext<ArtifactRendererLoader | null>(null);

/**
 * Provide the shell implementation. Apps mount this above the console shell:
 *
 * ```tsx
 * <ArtifactRendererProvider
 *   loader={() => import("@executor-js/mcp-apps-shell/shell/artifact-renderer")}
 * >
 * ```
 *
 * The loader must resolve to a module whose `default` export is the renderer,
 * which is what `React.lazy` consumes directly.
 */
export function ArtifactRendererProvider(
  props: React.PropsWithChildren<{ readonly loader: ArtifactRendererLoader }>,
) {
  return (
    <ArtifactRendererContext.Provider value={props.loader}>
      {props.children}
    </ArtifactRendererContext.Provider>
  );
}

/** The registered loader, or `null` on a host that provides none. */
export function useArtifactRendererLoader(): ArtifactRendererLoader | null {
  return React.useContext(ArtifactRendererContext);
}

/**
 * The lazy renderer component for the registered loader, or `null` when no host
 * registered one.
 *
 * `React.lazy` is memoized per loader identity: calling it inside render would
 * mint a fresh component type every pass and remount the shell (throwing away
 * the compiled iframe) on every parent re-render.
 */
export function useArtifactRenderer(): ArtifactRenderer | null {
  const loader = useArtifactRendererLoader();
  return React.useMemo(() => (loader ? React.lazy(loader) : null), [loader]);
}
