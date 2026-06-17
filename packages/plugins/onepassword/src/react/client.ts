import { createPluginAtomClient } from "@executor-js/sdk/client";
import {
  getExecutorServerAuthorizationHeader,
  getExecutorTenantApiBaseUrl,
} from "@executor-js/react/api/server-connection";
import { OnePasswordGroup } from "../api/group";

export const OnePasswordClient = createPluginAtomClient(OnePasswordGroup, {
  baseUrl: getExecutorTenantApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
});
