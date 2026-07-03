/* oxlint-disable executor/no-try-catch-or-throw, executor/no-unknown-error-message -- boundary: Next route handler translates request parsing failures into HTTP responses */
import { z } from "zod";
import { automationApprovalHook } from "@/lib/automation/hooks";
import { getAutomationApprovalForUser } from "@/lib/automation/store";
import { getServerSession } from "@/lib/session/get-server-session";

type RouteContext = {
  params: Promise<{ approvalId: string }>;
};

const approvalDecisionSchema = z.object({
  approved: z.boolean(),
  comment: z.string().optional(),
});

export async function POST(request: Request, context: RouteContext) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { approvalId } = await context.params;
  const approval = await getAutomationApprovalForUser({
    approvalId,
    userId: session.user.id,
  });
  if (!approval) {
    return Response.json({ error: "Approval not found" }, { status: 404 });
  }
  if (approval.approval.status !== "requested") {
    return Response.json(
      { error: `Approval is already ${approval.approval.status}` },
      { status: 409 },
    );
  }
  if (!approval.approval.workflowHookToken) {
    return Response.json({ error: "Approval is missing hook token" }, { status: 409 });
  }

  let body: z.infer<typeof approvalDecisionSchema>;
  try {
    body = approvalDecisionSchema.parse(await request.json());
  } catch (error) {
    return Response.json(
      { error: "Invalid approval decision", details: String(error) },
      { status: 400 },
    );
  }

  await automationApprovalHook.resume(approval.approval.workflowHookToken, {
    approvalId,
    approved: body.approved,
    decidedBy: session.user.id,
    comment: body.comment,
  });

  return Response.json({ ok: true });
}
