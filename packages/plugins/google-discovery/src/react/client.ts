import { createPluginAtomClient } from "@executor-js/sdk/client";
import { getBaseUrl } from "@executor-js/react/api/base-url";
import { GoogleDiscoveryGroup } from "../api/group";

export const GoogleDiscoveryClient = createPluginAtomClient(GoogleDiscoveryGroup, {
  baseUrl: getBaseUrl,
});
