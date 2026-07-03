import { start } from "workflow/api";

type AutomationMatch = {
  invocationId: string;
  status: "matched" | "skipped" | "duplicate" | "blocked";
};

type RouteResult = {
  eventId: string;
  matched: number;
  skipped: number;
  duplicates: number;
  blocked: number;
  startedRunIds: string[];
};

async function matchAutomationsStep(eventId: string) {
  "use step";
  const { matchAutomationsForEvent } = await import("@/lib/automation/store");
  return matchAutomationsForEvent(eventId);
}

async function startMatchedRunsStep(
  matches: AutomationMatch[],
) {
  "use step";

  const { automationRunWorkflow } = await import("./automation-run");
  const startedRunIds: string[] = [];
  await Promise.all(
    matches
      .filter((match) => match.status === "matched")
      .map(async (match) => {
        const run = await start(automationRunWorkflow, [match.invocationId]);
        startedRunIds.push(run.runId);
      }),
  );

  return startedRunIds;
}

startMatchedRunsStep.maxRetries = 3;

export async function automationRouterWorkflow(eventId: string): Promise<RouteResult> {
  "use workflow";

  const matches = await matchAutomationsStep(eventId);
  const startedRunIds = await startMatchedRunsStep(matches);

  return {
    eventId,
    matched: matches.filter((match) => match.status === "matched").length,
    skipped: matches.filter((match) => match.status === "skipped").length,
    duplicates: matches.filter((match) => match.status === "duplicate").length,
    blocked: matches.filter((match) => match.status === "blocked").length,
    startedRunIds,
  };
}
