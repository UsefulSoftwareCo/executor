/* oxlint-disable executor/no-try-catch-or-throw -- boundary: cron/source-polling adapter starts a Vercel Workflow and returns an HTTP-friendly start status */
import "server-only";

import { start } from "workflow/api";
import { automationSchedulerWorkflow } from "@/app/workflows/automation-scheduler";
import { isLinearPollingSourceEnabled } from "@/lib/linear/polling-config";
import { ensureLinearPollingAutomation } from "@/lib/linear/polling";
import { isSourcePollingGloballyEnabled } from "@/lib/source-polling/config";

export type SourcePollingKickResult = {
  started: boolean;
  reason?: string;
  runId?: string;
  eveSessionId?: string;
  sources?: string[];
  error?: string;
};

export async function ensureSourcePollingWorkflow(): Promise<SourcePollingKickResult> {
  if (!isSourcePollingGloballyEnabled()) {
    return { started: false, reason: "disabled" };
  }

  const sources: string[] = [];
  if (isLinearPollingSourceEnabled()) {
    await ensureLinearPollingAutomation();
    sources.push("linear");
  }
  if (sources.length === 0) {
    return { started: false, reason: "no-enabled-sources" };
  }

  try {
    const nowIso = new Date().toISOString();
    const run = await start(automationSchedulerWorkflow, [nowIso]);
    return {
      started: true,
      eveSessionId: run.runId,
      sources,
    };
  } catch {
    console.error("[source-polling] failed to start automation scheduler");
    return {
      started: false,
      reason: "start-failed",
      error: "Failed to start automation scheduler",
      sources,
    };
  }
}
