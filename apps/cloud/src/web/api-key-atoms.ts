import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { CloudApiClient } from "./client";

export const apiKeysAtom = CloudApiClient.query("cloudAuth", "listApiKeys", {
  reactivityKeys: [ReactivityKey.apiKeys],
});

export const createApiKey = CloudApiClient.mutation("cloudAuth", "createApiKey");
export const revokeApiKey = CloudApiClient.mutation("cloudAuth", "revokeApiKey");
