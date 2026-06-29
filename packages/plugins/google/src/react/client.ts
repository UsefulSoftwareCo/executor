import { createPluginAtomClient } from "@executor-js/sdk/client";
import {
  getExecutorOrganizationHeaders,
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";
import { GoogleGroup } from "../api/group";

export const GoogleClient = createPluginAtomClient(GoogleGroup, {
  baseUrl: getExecutorApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
  headers: getExecutorOrganizationHeaders,
});
