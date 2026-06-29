import { createPluginAtomClient } from "@executor-js/sdk/client";
import {
  getExecutorOrganizationHeaders,
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";
import { McpGroup } from "../api/group";

export const McpClient = createPluginAtomClient(McpGroup, {
  baseUrl: getExecutorApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
  headers: getExecutorOrganizationHeaders,
});
