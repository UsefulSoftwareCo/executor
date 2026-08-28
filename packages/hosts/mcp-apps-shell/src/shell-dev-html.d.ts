/**
 * The built shell document's BYTES under `vite dev`, or `undefined` in a
 * build — supplied by `mcpAppsShellAsset` (`@executor-js/mcp-apps-shell/vite`).
 *
 * Only Workers hosts import this, as the `devShellHtml` thunk for
 * `makeAssetsShellHtmlLoader`: in dev no assets have been emitted for the
 * ASSETS binding to find, so the document travels inline; in a deployed
 * build this module is `undefined` and the binding is the real path.
 */
declare module "virtual:executor-mcp-apps-shell-dev-html" {
  const devShellHtml: string | undefined;
  export { devShellHtml };
  export default devShellHtml;
}
