/* oxlint-disable executor/no-promise-catch -- boundary: Next route handler accepts optional JSON and falls back to a generated test event */
import { getAutomationForUser } from "@/lib/automation/store";
import { buildAutomationDryRunPreview } from "@/lib/automation/preview";
import { buildAutomationTestEventInput } from "@/lib/automation/test-event";
import { parseAutomationDefinition } from "@/lib/automation/types";
import { getServerSession } from "@/lib/session/get-server-session";
import { emitAndRouteAutomationEvent } from "../../_lib/dispatch";

type RouteContext = {
  params: Promise<{ automationId: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request, context: RouteContext) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { automationId } = await context.params;
  const automation = await getAutomationForUser({
    automationId,
    userId: session.user.id,
  });
  if (!automation?.version) {
    return Response.json({ error: "Automation not found" }, { status: 404 });
  }

  const definition = parseAutomationDefinition(automation.version.definitionJson);
  const body = await request.json().catch(() => ({}));
  const eventInput = buildAutomationTestEventInput({
    automationId,
    userId: session.user.id,
    definition,
    body,
  });

  if (isRecord(body) && body.dryRun === true) {
    return Response.json({
      dryRun: true,
      preview: await buildAutomationDryRunPreview({
        automationId,
        definition,
        event: eventInput,
        userId: session.user.id,
      }),
    });
  }

  const event = await emitAndRouteAutomationEvent(eventInput);
  return Response.json(event, { status: 202 });
}
