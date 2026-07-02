import { CloudApiClient } from "./client";

export const mcpPausedExecutionAtom = (mcpSessionId: string, executionId: string) =>
  CloudApiClient.query("cloudAuth", "getMcpPaused", {
    params: { mcpSessionId, executionId },
    timeToLive: "5 seconds",
  });

export const resumeMcpExecution = CloudApiClient.mutation("cloudAuth", "resumeMcpExecution");
