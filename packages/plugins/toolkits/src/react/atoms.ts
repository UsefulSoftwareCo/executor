// ---------------------------------------------------------------------------
// Query + mutation atoms for the toolkits console page.
//
// The `list` query returns every toolkit the caller can see (workspace +
// personal); the page splits by `scope`. Mutations pass `toolkitWriteKeys` at
// the call site so the list refreshes after a create / update / remove.
// ---------------------------------------------------------------------------

import { ReactivityKey, toolkitWriteKeys } from "@executor-js/react/api/reactivity-keys";

import { ToolkitsClient } from "./client";

export { toolkitWriteKeys };

export const toolkitsAtom = ToolkitsClient.query("toolkits", "list", {
  timeToLive: "15 seconds",
  reactivityKeys: [ReactivityKey.toolkits],
});

export const createToolkit = ToolkitsClient.mutation("toolkits", "create");
export const updateToolkit = ToolkitsClient.mutation("toolkits", "update");
export const removeToolkit = ToolkitsClient.mutation("toolkits", "remove");
