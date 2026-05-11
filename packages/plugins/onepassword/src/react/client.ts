import { createPluginAtomClient } from "@executor-js/sdk/client";
import { getBaseUrl } from "@executor-js/react/api/base-url";
import { OnePasswordGroup } from "../api/group";

export const OnePasswordClient = createPluginAtomClient(OnePasswordGroup, {
  baseUrl: getBaseUrl,
});
