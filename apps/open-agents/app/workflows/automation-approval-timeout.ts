import { sleep } from "workflow";
import { automationApprovalHook } from "@/lib/automation/hooks";

type AutomationApprovalTimeoutInput = {
  approvalId: string;
  hookToken: string;
  timeoutMs: number;
};

async function expireApprovalIfStillRequestedStep(
  approvalId: string,
): Promise<boolean> {
  "use step";
  const { expireAutomationApproval } = await import("@/lib/automation/store");
  const approval = await expireAutomationApproval({
    approvalId,
    reason: "Approval timed out",
  });
  return Boolean(approval);
}

async function resumeTimedOutApprovalStep(params: {
  approvalId: string;
  hookToken: string;
}) {
  "use step";
  await automationApprovalHook.resume(params.hookToken, {
    approvalId: params.approvalId,
    approved: false,
    decidedBy: "system:approval-timeout",
    comment: "Approval timed out",
  });
}

resumeTimedOutApprovalStep.maxRetries = 3;

export async function automationApprovalTimeoutWorkflow(
  input: AutomationApprovalTimeoutInput,
) {
  "use workflow";

  await sleep(new Date(Date.now() + input.timeoutMs));
  const expired = await expireApprovalIfStillRequestedStep(input.approvalId);
  if (!expired) {
    return { approvalId: input.approvalId, status: "already-decided" };
  }

  await resumeTimedOutApprovalStep({
    approvalId: input.approvalId,
    hookToken: input.hookToken,
  });

  return { approvalId: input.approvalId, status: "expired" };
}
