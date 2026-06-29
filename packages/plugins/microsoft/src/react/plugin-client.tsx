import { defineClientPlugin } from "@executor-js/sdk/client";

import { microsoftIntegrationPlugin } from "./source-plugin";

export default defineClientPlugin({
  id: "microsoft" as const,
  integrationPlugin: microsoftIntegrationPlugin,
});
