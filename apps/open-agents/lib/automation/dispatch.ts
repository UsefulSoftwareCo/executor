import "server-only";

import { start } from "workflow/api";
import { automationRouterWorkflow } from "@/app/workflows/automation-router";
import { emitAutomationEvent } from "./store";
import type { AutomationEventInput } from "./types";

export async function emitAndRouteAutomationEvent(input: AutomationEventInput) {
  const result = await emitAutomationEvent(input);
  const routerRun = result.inserted
    ? await start(automationRouterWorkflow, [result.event.id])
    : null;

  return {
    event: result.event,
    inserted: result.inserted,
    routerRunId: routerRun?.runId ?? null,
  };
}
