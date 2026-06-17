import { createPluginAtomClient } from "@executor-js/sdk/client";
import {
  getExecutorServerAuthorizationHeader,
  getExecutorTenantApiBaseUrl,
} from "@executor-js/react/api/server-connection";
import { OpenApiGroup } from "../api/group";

export const OpenApiClient = createPluginAtomClient(OpenApiGroup, {
  baseUrl: getExecutorTenantApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
});
