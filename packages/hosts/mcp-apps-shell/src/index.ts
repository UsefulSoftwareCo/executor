/**
 * The MCP-Apps shell: the trusted iframe host that renders model-written JSX.
 *
 * The shell reaches MCP clients as a single self-contained HTML document (the
 * `ui://executor/shell.html` resource), handed to the MCP host through the
 * `loadAppShellHtml` config seam — the MCP host never imports this package
 * directly, so React/Recharts/Tailwind stay out of the Workers graph. Hosts
 * with a filesystem read it with `loadMcpAppsShellHtml`; Workers hosts fetch
 * it through their ASSETS binding with `makeAssetsShellHtmlLoader`
 * (`@executor-js/mcp-apps-shell/worker`).
 */

export { loadMcpAppsShellHtml } from "./shell-html";
