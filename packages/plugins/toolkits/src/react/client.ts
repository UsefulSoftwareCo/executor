// ---------------------------------------------------------------------------
// @executor-js/plugin-toolkits/react — the typed reactive client
//
// `createPluginAtomClient` builds an AtomHttpApi service keyed to the toolkits
// group, reusing the host's active Executor Server Connection for the base URL
// and (self-host) authorization header — the same wiring every first-party
// plugin client uses.
// ---------------------------------------------------------------------------

import { createPluginAtomClient } from "@executor-js/sdk/client";
import {
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";

import { ToolkitsApi } from "../shared";

export const ToolkitsClient = createPluginAtomClient(ToolkitsApi, {
  baseUrl: getExecutorApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
});
