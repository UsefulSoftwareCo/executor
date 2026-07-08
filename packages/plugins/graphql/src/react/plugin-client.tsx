import { defineClientPlugin } from "@executor-js/sdk/client";

import { graphqlIntegrationPlugin } from "./integration-plugin";

export default defineClientPlugin({
  id: "graphql" as const,
  integrationPlugin: graphqlIntegrationPlugin,
});
