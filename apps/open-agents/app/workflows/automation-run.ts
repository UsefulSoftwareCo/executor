/* oxlint-disable executor/no-try-catch-or-throw, executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: Vercel Workflow steps use thrown FatalError/RetryableError semantics and persist failure text for run history */
import { FatalError, getStepMetadata, getWorkflowMetadata } from "workflow";
import { start } from "workflow/api";
import { automationApprovalHook } from "@/lib/automation/hooks";

type AutomationActionExecutionResult = {
  status: "succeeded" | "succeeded_with_findings" | "needs_review" | "failed";
  summary: string;
  data?: unknown;
  emittedEventIds?: string[];
};

type AutomationPolicyLike = {
  autonomy: string;
  approvals: Array<{
    when: string;
    required: boolean;
    reason?: string;
    timeoutMs?: number;
  }>;
};

async function prepareAutomationRunStep(invocationId: string, eveSessionId: string) {
  "use step";
  const { prepareAutomationRun } = await import("@/lib/automation/store");
  return prepareAutomationRun({ invocationId, eveSessionId });
}

async function createBeforeRunApprovalStep(
  runId: string,
  request: Record<string, unknown>,
  timeoutMs: number | null,
) {
  "use step";
  const { createAutomationApproval } = await import("@/lib/automation/store");
  const approval = await createAutomationApproval({
    runId,
    kind: "before-run",
    request,
  });
  return {
    approvalId: approval.id,
    hookToken: approval.workflowHookToken,
    timeoutMs,
  };
}

async function recordApprovalDecisionStep(params: {
  approvalId: string;
  approved: boolean;
  decidedBy: string;
  comment?: string;
}) {
  "use step";
  const { recordAutomationApprovalDecision } = await import(
    "@/lib/automation/store"
  );
  return recordAutomationApprovalDecision({
    approvalId: params.approvalId,
    approved: params.approved,
    decidedBy: params.decidedBy,
    decision: {
      approved: params.approved,
      decidedBy: params.decidedBy,
      comment: params.comment,
    },
  });
}

async function markRunRunningStep(runId: string) {
  "use step";
  const { markAutomationRunRunning } = await import("@/lib/automation/store");
  await markAutomationRunRunning(runId);
}

async function executeAutomationActionStep(runId: string) {
  "use step";
  const { executeAutomationAction } = await import("@/lib/automation/actions");
  const metadata = getStepMetadata();
  return executeAutomationAction(runId, {
    idempotencyKey: `${runId}:${metadata.stepId}`,
    attempt: metadata.attempt,
  });
}

executeAutomationActionStep.maxRetries = 5;

async function finalizeAutomationRunStep(
  runId: string,
  result: AutomationActionExecutionResult,
) {
  "use step";
  const { finalizeAutomationRun } = await import("@/lib/automation/store");
  await finalizeAutomationRun({
    runId,
    status: result.status,
    result: result.data ?? result.summary,
    error: result.status === "failed" ? result.summary : undefined,
  });
}

async function failAutomationRunStep(runId: string, error: string) {
  "use step";
  const { finalizeAutomationRun } = await import("@/lib/automation/store");
  await finalizeAutomationRun({
    runId,
    status: "failed",
    error,
  });
}

async function blockAutomationRunStep(runId: string, error: string) {
  "use step";
  const { finalizeAutomationRun } = await import("@/lib/automation/store");
  await finalizeAutomationRun({
    runId,
    status: "blocked",
    error,
  });
}

async function startRoutersForEmittedEventsStep(eventIds: string[]) {
  "use step";
  if (eventIds.length === 0) {
    return [];
  }

  const { automationRouterWorkflow } = await import("./automation-router");
  const runs = await Promise.all(
    eventIds.map((eventId) => start(automationRouterWorkflow, [eventId])),
  );
  return runs.map((run) => run.runId);
}

startRoutersForEmittedEventsStep.maxRetries = 3;

async function startApprovalTimeoutWorkflowStep(params: {
  approvalId: string;
  hookToken: string;
  timeoutMs: number;
}) {
  "use step";
  const { automationApprovalTimeoutWorkflow } = await import(
    "./automation-approval-timeout"
  );
  const run = await start(automationApprovalTimeoutWorkflow, [
    {
      approvalId: params.approvalId,
      hookToken: params.hookToken,
      timeoutMs: params.timeoutMs,
    },
  ]);
  return run.runId;
}

startApprovalTimeoutWorkflowStep.maxRetries = 3;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiresBeforeRunApproval(policy: AutomationPolicyLike): boolean {
  if (policy.autonomy === "production") {
    return true;
  }
  return policy.approvals.some(
    (approval) => approval.required && approval.when === "before-run",
  );
}

function getBeforeRunApprovalRule(policy: AutomationPolicyLike) {
  return policy.approvals.find(
    (approval) => approval.required && approval.when === "before-run",
  );
}

export async function automationRunWorkflow(invocationId: string) {
  "use workflow";

  const eveSessionId = getWorkflowMetadata().workflowRunId;
  const prepared = await prepareAutomationRunStep(invocationId, eveSessionId);
  if (prepared.status !== "prepared") {
    return {
      runId: prepared.run.id,
      status: prepared.status,
      reason: prepared.reason,
    };
  }

  const { run, definition, event, automation, version } = prepared;

  if (requiresBeforeRunApproval(definition.policy)) {
    const approvalRule = getBeforeRunApprovalRule(definition.policy);
    const timeoutMs = approvalRule?.timeoutMs ?? 24 * 60 * 60 * 1000;
    const approval = await createBeforeRunApprovalStep(
      run.id,
      {
        automationId: automation.id,
        automationName: automation.name,
        automationVersion: version.version,
        runId: run.id,
        eventId: event.id,
        eventType: event.type,
        reason:
          approvalRule?.reason ??
          "This automation policy requires review before it runs.",
      },
      timeoutMs,
    );

    if (!approval.hookToken) {
      throw new FatalError("Approval hook token was not recorded");
    }

    const hook = automationApprovalHook.create({
      token: approval.hookToken,
      metadata: {
        approvalId: approval.approvalId,
        runId: run.id,
        automationId: automation.id,
      },
    });

    await startApprovalTimeoutWorkflowStep({
      approvalId: approval.approvalId,
      hookToken: approval.hookToken,
      timeoutMs,
    });

    const decision = await hook;
    hook.dispose();

    if (decision.decidedBy === "system:approval-timeout") {
      await blockAutomationRunStep(run.id, "Approval timed out");
      return { runId: run.id, status: "blocked", reason: "approval-timeout" };
    }

    await recordApprovalDecisionStep(decision);
    if (!decision.approved) {
      await blockAutomationRunStep(run.id, decision.comment ?? "Approval denied");
      return { runId: run.id, status: "blocked", reason: "approval-denied" };
    }

    await markRunRunningStep(run.id);
  }

  let result: AutomationActionExecutionResult;
  try {
    result = await executeAutomationActionStep(run.id);
  } catch (error) {
    const message = toErrorMessage(error);
    await failAutomationRunStep(run.id, message);
    throw error;
  }

  await finalizeAutomationRunStep(run.id, result);
  const emittedRouterRunIds = await startRoutersForEmittedEventsStep(
    result.emittedEventIds ?? [],
  );

  return {
    runId: run.id,
    status: result.status,
    summary: result.summary,
    emittedRouterRunIds,
  };
}
