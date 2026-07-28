import { ArtifactRendererProvider } from "@executor-js/react/api/artifact-renderer";
import type { ArtifactRendererProps } from "@executor-js/react/api/artifact-renderer";

import { McpAppsShell, type McpAppsShellHost } from "./shell-app";

/**
 * Binds the MCP-Apps shell to the console's artifact page.
 *
 * The console declares an artifact-renderer seam it cannot fill itself: this
 * package depends on `@executor-js/react` for its component barrel, so the
 * reverse import would close a package cycle. App composition roots — which
 * already depend on both — mount this provider to complete the wiring.
 *
 * ```tsx
 * import { ArtifactShellProvider } from "@executor-js/mcp-apps-shell/shell/artifact-renderer";
 *
 * <ArtifactShellProvider>
 *   <Shell />
 * </ArtifactShellProvider>
 * ```
 */
export function ArtifactShellProvider(props: { readonly children: React.ReactNode }) {
  return (
    <ArtifactRendererProvider renderer={ArtifactShell}>{props.children}</ArtifactRendererProvider>
  );
}

/**
 * The stored source is passed as `initialCode` rather than replayed through a
 * synthetic `ontoolresult`: on this page there is no MCP client to deliver a
 * tool result, and the shell already treats `initialCode` as the render trigger.
 */
function ArtifactShell(props: ArtifactRendererProps) {
  return <McpAppsShell app={props.host as McpAppsShellHost} initialCode={props.code} />;
}
