import { createPluginAtomClient } from "@executor-js/sdk/client";
import {
  getExecutorServerAuthorizationHeader,
  getExecutorTenantApiBaseUrl,
} from "@executor-js/react/api/server-connection";
import { McpGroup } from "../api/group";

export const McpClient = createPluginAtomClient(McpGroup, {
  baseUrl: getExecutorTenantApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
});
