/* oxlint-disable executor/no-try-catch-or-throw, executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: Next route handlers translate request parsing and repository failures into HTTP responses */
import { AuthzError } from "@open-agents/authz";
import { z } from "zod";
import {
  listAutomationsForUser,
  upsertAutomationDefinition,
} from "@/lib/automation/store";
import {
  buildAutomationTemplate,
  getAutomationTemplates,
  type AutomationTemplateId,
} from "@/lib/automation/templates";
import type { AutomationDefinitionInput } from "@/lib/automation/types";
import { getServerSession } from "@/lib/session/get-server-session";

const createAutomationSchema = z.object({
  definition: z.unknown().optional(),
  templateId: z
    .enum([
      "pr-babysitter",
      "ci-failure-fixer",
      "linear-triage",
      "slack-bug-triage",
      "daily-brief",
      "custom-webhook-triage",
    ])
    .optional(),
  scope: z
    .object({
      kind: z.enum(["user", "group", "org"]),
      id: z.string().min(1),
    })
    .optional(),
  changeSummary: z.string().optional(),
});

export async function GET() {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const automations = await listAutomationsForUser(session.user.id);
  const templates = getAutomationTemplates({ userId: session.user.id });
  return Response.json({ automations, templates });
}

export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: z.infer<typeof createAutomationSchema>;
  try {
    body = createAutomationSchema.parse(await request.json());
  } catch (error) {
    return Response.json(
      { error: "Invalid automation request", details: String(error) },
      { status: 400 },
    );
  }

  const definition: AutomationDefinitionInput | null =
    body.definition
      ? (body.definition as AutomationDefinitionInput)
      : body.templateId
      ? buildAutomationTemplate(body.templateId as AutomationTemplateId, {
          userId: session.user.id,
          scope: body.scope,
        })
      : null;

  if (!definition) {
    return Response.json(
      { error: "Provide either definition or templateId" },
      { status: 400 },
    );
  }

  try {
    const saved = await upsertAutomationDefinition({
      userId: session.user.id,
      definition,
      changeSummary: body.changeSummary,
    });
    return Response.json(saved, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: error instanceof AuthzError ? error.status : 400 },
    );
  }
}
