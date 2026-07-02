import { defineClientPlugin } from "@executor-js/sdk/client";

import { graphqlIntegrationPlugin } from "./source-plugin";

export default defineClientPlugin({
  id: "graphql" as const,
  integrationPlugin: graphqlIntegrationPlugin,
});
