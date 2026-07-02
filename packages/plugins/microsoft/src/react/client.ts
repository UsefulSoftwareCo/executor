import { createPluginAtomClient } from "@executor-js/sdk/client";
import {
  getExecutorOrganizationHeaders,
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";
import { MicrosoftGroup } from "../api/group";

export const MicrosoftClient = createPluginAtomClient(MicrosoftGroup, {
  baseUrl: getExecutorApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
  headers: getExecutorOrganizationHeaders,
});
