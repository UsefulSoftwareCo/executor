import { getAutomationRunForUser } from "@/lib/automation/store";
import { getServerSession } from "@/lib/session/get-server-session";

type RouteContext = {
  params: Promise<{ runId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { runId } = await context.params;
  const run = await getAutomationRunForUser({
    runId,
    userId: session.user.id,
  });
  if (!run) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  return Response.json({ run });
}
