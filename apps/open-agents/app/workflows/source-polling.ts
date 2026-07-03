import { sleep } from "workflow";
import {
  getSourcePollingIntervalMs,
  getSourcePollingLeaseTtlMs,
  isSourcePollingGloballyEnabled,
} from "@/lib/source-polling/config";
import { pollEnabledSources } from "@/lib/source-polling/sources";
import {
  clearSourcePollingLease,
  refreshSourcePollingLease,
} from "@/lib/source-polling/state";

type SourcePollingDecision = {
  shouldContinue: boolean;
  intervalMs?: number;
  reason?: string;
};

async function runSourcePollingCycle(
  runId: string,
): Promise<SourcePollingDecision> {
  "use step";

  if (!isSourcePollingGloballyEnabled()) {
    return { shouldContinue: false, reason: "disabled" };
  }

  const ownsLease = await refreshSourcePollingLease(
    runId,
    getSourcePollingLeaseTtlMs(),
  );
  if (!ownsLease) {
    return { shouldContinue: false, reason: "lease-lost" };
  }

  const results = await pollEnabledSources();
  if (results.length === 0) {
    return { shouldContinue: false, reason: "no-enabled-sources" };
  }

  return {
    shouldContinue: true,
    intervalMs: getSourcePollingIntervalMs(),
  };
}

async function clearSourcePollingLeaseIfOwned(runId: string): Promise<void> {
  "use step";
  await clearSourcePollingLease(runId);
}

export async function sourcePollingWorkflow(runId: string) {
  "use workflow";

  while (true) {
    const decision = await runSourcePollingCycle(runId);
    if (!decision.shouldContinue || decision.intervalMs === undefined) {
      await clearSourcePollingLeaseIfOwned(runId);
      return { skipped: true, reason: decision.reason ?? "no-decision" };
    }

    await sleep(new Date(Date.now() + decision.intervalMs));
  }
}
