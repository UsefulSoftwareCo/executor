/* oxlint-disable executor/no-try-catch-or-throw, executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: Next route handlers translate request parsing and repository failures into HTTP responses */
import { AuthzError } from "@open-agents/authz";
import { getAutomationForUser, upsertAutomationDefinition } from "@/lib/automation/store";
import type { AutomationDefinitionInput } from "@/lib/automation/types";
import { getServerSession } from "@/lib/session/get-server-session";

type RouteContext = {
  params: Promise<{ automationId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { automationId } = await context.params;
  const automation = await getAutomationForUser({
    automationId,
    userId: session.user.id,
  });
  if (!automation) {
    return Response.json({ error: "Automation not found" }, { status: 404 });
  }

  return Response.json(automation);
}

export async function PATCH(request: Request, context: RouteContext) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { automationId } = await context.params;
  const existing = await getAutomationForUser({
    automationId,
    userId: session.user.id,
  });
  if (!existing?.version) {
    return Response.json({ error: "Automation not found" }, { status: 404 });
  }

  let body: {
    definition?: unknown;
    enabled?: boolean;
    changeSummary?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const definition: AutomationDefinitionInput =
    body.definition && typeof body.definition === "object"
      ? ({
          ...(body.definition as Record<string, unknown>),
          id: automationId,
        } as AutomationDefinitionInput)
      : ({
          ...existing.version.definitionJson,
          id: automationId,
          enabled: body.enabled ?? existing.automation.enabled,
        } as AutomationDefinitionInput);

  if (body.enabled !== undefined) {
    (definition as Record<string, unknown>).enabled = body.enabled;
  }

  try {
    const saved = await upsertAutomationDefinition({
      userId: session.user.id,
      definition,
      changeSummary: body.changeSummary,
    });
    return Response.json(saved);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: error instanceof AuthzError ? error.status : 400 },
    );
  }
}
