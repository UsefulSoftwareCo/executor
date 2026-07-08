import { defineClientPlugin } from "@executor-js/sdk/client";

import { makeAppsIntegrationPlugin } from "./source-plugin";
import type { AppSourceKind } from "./custom-tools-client";

export { makeAppsIntegrationPlugin } from "./source-plugin";
export * from "./custom-tools-client";

export default function appsClientPlugin(config?: {
  readonly sourceKinds?: readonly AppSourceKind[];
}) {
  return defineClientPlugin({
    id: "apps",
    integrationPlugin: makeAppsIntegrationPlugin(config),
  });
}
