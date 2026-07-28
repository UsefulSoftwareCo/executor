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
// ---------------------------------------------------------------------------

/** What the page hands the shell: the stored source, and the live host. */
export interface ArtifactRendererProps {
  /** The artifact's stored JSX source. */
  readonly code: string;
  /** HTTP-backed MCP host — see `createHttpShellHost` in `./shell-host`. */
  readonly host: unknown;
}

export type ArtifactRenderer = React.ComponentType<ArtifactRendererProps>;

const ArtifactRendererContext = React.createContext<ArtifactRenderer | null>(null);

/**
 * Provide the shell implementation. Apps mount this above the console shell:
 *
 * ```tsx
 * import { McpAppsShell } from "@executor-js/mcp-apps-shell/shell/shell-app";
 *
 * <ArtifactRendererProvider
 *   renderer={({ code, host }) => <McpAppsShell app={host} initialCode={code} />}
 * >
 * ```
 */
export function ArtifactRendererProvider(
  props: React.PropsWithChildren<{ readonly renderer: ArtifactRenderer }>,
) {
  return (
    <ArtifactRendererContext.Provider value={props.renderer}>
      {props.children}
    </ArtifactRendererContext.Provider>
  );
}

/** The registered renderer, or `null` on a host that provides none. */
export function useArtifactRenderer(): ArtifactRenderer | null {
  return React.useContext(ArtifactRendererContext);
}
