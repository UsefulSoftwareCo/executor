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
  /** Which artifact this is. The source addresses integrations by role, so the
   *  server needs the row to resolve a role to a connection; this is how the id
   *  reaches `execute-action`. */
  readonly artifactId: string;
  /** HTTP-backed MCP host — see `createHttpShellHost` in `./shell-host`. */
  readonly host: unknown;
  /**
   * Called once, when the artifact has actually painted inside the frame.
   *
   * This is what lets the page hold ONE loading surface from navigation until
   * there is something real to look at, rather than flashing a placeholder per
   * stage of the boot. The shell owns the fact — the console cannot see inside
   * a sandboxed frame two documents down — so it reports it; see
   * `ARTIFACT_RENDERED_TOOL` in the shell package.
   *
   * Fires for the error surfaces too. "Rendered" here means presented, not
   * succeeded: a compile failure is still the moment the user should be looking
   * at the frame instead of a skeleton, and a signal that fired only on success
   * would leave every failed artifact under a loading state forever.
   *
   * Optional, so a host that does not care simply omits it and nothing in the
   * chain changes.
   */
  readonly onRendered?: (() => void) | undefined;
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

/**
 * Loaders whose chunk has already been asked for.
 *
 * The dedupe is not for the network — a bundler's own module registry already
 * serves a second `import()` of the same specifier from memory. It is so this
 * module does not hand React's scheduler a new promise on every render of every
 * component that preloads, and so the cost of "preload on hover" style callers
 * is provably zero after the first.
 *
 * Keyed by loader identity, matching how `useArtifactRenderer` memoizes
 * `React.lazy`; the composition roots define their loader at module scope
 * precisely so that identity is stable for the life of the app.
 */
const preloaded = new WeakSet<ArtifactRendererLoader>();

/**
 * Start fetching the renderer chunk before anything needs to render it.
 *
 * ## What this removes
 *
 * The renderer arrives through a dynamic `import()`, and until now that import
 * was first touched when the detail page rendered — which is only after the
 * artifact row has been fetched. So a cold open serialized two waits the user
 * saw as two different placeholders: "loading the row", then "loading the code
 * that draws rows". They are independent, and overlapping them makes the second
 * free.
 *
 * ## Why fire-and-forget is right
 *
 * There is nothing to do with the result. Success populates the bundler's
 * module cache, which is the entire point, and `React.lazy` will find it there.
 * FAILURE is deliberately swallowed here rather than surfaced: this is a
 * speculative fetch, the user may never open an artifact, and a chunk that
 * genuinely cannot load must fail where a user is actually waiting on it — at
 * the `Suspense` boundary, with the page's own error surface — not as an
 * unhandled rejection logged from a hover. Retrying is automatic in the sense
 * that matters: `React.lazy` calls the same loader again and gets a fresh
 * attempt, because a rejected `import()` is not cached by any bundler.
 */
export function preloadArtifactRenderer(loader: ArtifactRendererLoader | null): void {
  if (!loader || preloaded.has(loader)) return;
  preloaded.add(loader);
  void loader().then(
    () => undefined,
    () => {
      // Let a failed speculative fetch be tried again for real. Without this a
      // transient network blip during the preload would mark the loader done
      // and the actual open would never re-attempt from here.
      preloaded.delete(loader);
    },
  );
}

/**
 * Kick the renderer chunk as soon as the mounting surface exists.
 *
 * Mounted by the artifacts LIST as well as the detail page: by the time a user
 * has the gallery on screen, opening one of the cards is the only thing that
 * page is for, so the chunk is fetched during the time they spend choosing.
 * That is what turns the renderer's own placeholder into something that never
 * appears in a warm session, and shortens it to nothing in a cold one.
 *
 * An effect rather than a render-phase call, so the fetch is never started
 * during SSR or a discarded render pass.
 */
export function usePreloadArtifactRenderer(): void {
  const loader = useArtifactRendererLoader();
  React.useEffect(() => {
    preloadArtifactRenderer(loader);
  }, [loader]);
}
