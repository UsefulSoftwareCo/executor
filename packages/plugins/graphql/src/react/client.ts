import { createPluginAtomClient } from "@executor-js/sdk/client";
import { getBaseUrl } from "@executor-js/react/api/base-url";
import { GraphqlGroup } from "../api/group";

export const GraphqlClient = createPluginAtomClient(GraphqlGroup, {
  baseUrl: getBaseUrl,
});
