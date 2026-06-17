import { createPluginAtomClient } from "@executor-js/sdk/client";
import {
  getExecutorServerAuthorizationHeader,
  getExecutorTenantApiBaseUrl,
} from "@executor-js/react/api/server-connection";
import { GraphqlGroup } from "../api/group";

export const GraphqlClient = createPluginAtomClient(GraphqlGroup, {
  baseUrl: getExecutorTenantApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
});
