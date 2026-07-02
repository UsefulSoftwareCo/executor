import { defineClientPlugin } from "@executor-js/sdk/client";

import { googleIntegrationPlugin } from "./source-plugin";

export default defineClientPlugin({
  id: "google" as const,
  integrationPlugin: googleIntegrationPlugin,
});
