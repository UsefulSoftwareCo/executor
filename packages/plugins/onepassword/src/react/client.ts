import { createPluginAtomClient } from "@executor-js/sdk/client";
import {
  getExecutorOrganizationHeaders,
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";
import { OnePasswordGroup } from "../api/group";

export const OnePasswordClient = createPluginAtomClient(OnePasswordGroup, {
  baseUrl: getExecutorApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
  headers: getExecutorOrganizationHeaders,
});
