import type { ArtifactRendererProps } from "@executor-js/react/api/artifact-renderer";

import { McpAppsShell, type McpAppsShellHost } from "./shell-app";

/**
 * Binds the MCP-Apps shell to the console's artifact page.
 *
 * This module is BROWSER-ONLY and must never enter a server graph: it pulls in
 * `shell-app`, which imports `@tailwindcss/browser`, and that package builds a
 * `<style>` element at import scope. Under SSR that is an immediate
 * `ReferenceError: document is not defined` — thrown while the entry graph
 * loads, long before any component renders.
 *
 * So nothing imports it statically. The console declares an artifact-renderer
 * seam that takes an async loader, and app composition roots — which already
 * depend on both packages — register this module through a dynamic `import()`
 * that only ever resolves in the browser:
 *
 * ```tsx
 * <ArtifactRendererProvider
 *   loader={() => import("@executor-js/mcp-apps-shell/shell/artifact-renderer")}
 * >
 * ```
 *
 * The seam hands that loader to `React.lazy`, which is why the renderer is the
 * DEFAULT export.
 *
 * (The seam is inverted in the first place because this package depends on
 * `@executor-js/react` for its component barrel, so importing the shell back
 * into that package would close a cycle turbo rejects outright.)
 *
 * The stored source is passed as `initialCode` rather than replayed through a
 * synthetic `ontoolresult`: on this page there is no MCP client to deliver a
 * tool result, and the shell already treats `initialCode` as the render trigger.
 */
export default function ArtifactShell(props: ArtifactRendererProps) {
  return <McpAppsShell app={props.host as McpAppsShellHost} initialCode={props.code} />;
}
