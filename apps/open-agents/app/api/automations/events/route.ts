/* oxlint-disable executor/no-try-catch-or-throw, executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: Next route handler translates request parsing and event routing failures into HTTP responses */
import { getServerSession } from "@/lib/session/get-server-session";
import { emitAndRouteAutomationEvent } from "../_lib/dispatch";

export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await emitAndRouteAutomationEvent(body as never);
    return Response.json(result, { status: 202 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
