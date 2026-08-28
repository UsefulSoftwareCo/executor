/**
 * The URL of the built, self-contained shell document, supplied by
 * `mcpAppsShellAsset` (`@executor-js/mcp-apps-shell/vite`).
 *
 * Only a URL crosses this seam, never the document's bytes: the artifact page
 * loads it into an iframe, so the 4.5 MB shell must stay out of the console's
 * JS chunks.
 */
declare module "virtual:executor-mcp-apps-shell-html" {
  const shellHtmlUrl: string;
  export { shellHtmlUrl };
  export default shellHtmlUrl;
}
