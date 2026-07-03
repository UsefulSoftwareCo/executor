/* oxlint-disable executor/no-try-catch-or-throw, executor/no-json-parse -- boundary: public webhook adapter accepts arbitrary JSON and falls back to a text payload */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { automationDefinitions, automationVersions } from "@/lib/db/schema";
import {
  parseAutomationDefinition,
  type AutomationDefinition,
} from "@/lib/automation/types";
import { emitAndRouteAutomationEvent } from "../../_lib/dispatch";

type RouteContext = {
  params: Promise<{ automationId: string }>;
};

function toDedupeKey(request: Request, automationId: string, bodyText: string): string {
  return (
    request.headers.get("x-open-agents-event-id") ??
    request.headers.get("x-request-id") ??
    `custom:${automationId}:${crypto.randomUUID()}:${bodyText.length}`
  );
}

function toEventScope(scope: AutomationDefinition["scope"]) {
  return { kind: scope.kind, id: scope.id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getWebhookSecret(definition: AutomationDefinition): string | null {
  const tools = definition.tools;
  if (!isRecord(tools)) {
    return null;
  }
  const value =
    tools.webhookSecret ??
    tools.webhookSigningSecret ??
    tools.customWebhookSecret;
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeSignature(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.startsWith("sha256=") ? trimmed.slice("sha256=".length) : trimmed;
}

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  return authorization.slice("bearer ".length).trim();
}

function constantTimeEqual(left: string | null, right: string | null): boolean {
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function hmacSha256(secret: string, bodyText: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(bodyText));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyWebhookSecret(params: {
  request: Request;
  bodyText: string;
  secret: string;
}): Promise<boolean> {
  const directSecret =
    params.request.headers.get("x-open-agents-webhook-secret") ??
    getBearerToken(params.request);
  if (constantTimeEqual(directSecret, params.secret)) {
    return true;
  }

  const signature = normalizeSignature(
    params.request.headers.get("x-open-agents-signature") ??
      params.request.headers.get("x-hub-signature-256"),
  );
  const expected = await hmacSha256(params.secret, params.bodyText);
  return constantTimeEqual(signature, expected);
}

export async function POST(request: Request, context: RouteContext) {
  const { automationId } = await context.params;
  const automation = await db.query.automationDefinitions.findFirst({
    where: eq(automationDefinitions.id, automationId),
  });
  if (!automation?.currentVersionId || !automation.enabled) {
    return Response.json({ error: "Automation not found" }, { status: 404 });
  }

  const version = await db.query.automationVersions.findFirst({
    where: eq(automationVersions.id, automation.currentVersionId),
  });
  if (!version) {
    return Response.json({ error: "Automation version not found" }, { status: 404 });
  }

  const definition = parseAutomationDefinition(version.definitionJson);
  const bodyText = await request.text();
  const webhookSecret = getWebhookSecret(definition);
  if (
    webhookSecret &&
    !(await verifyWebhookSecret({ request, bodyText, secret: webhookSecret }))
  ) {
    return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    payload = { text: bodyText };
  }

  const subject = {
    kind: "webhook",
    id:
      request.headers.get("x-open-agents-subject-id") ??
      request.headers.get("x-github-delivery") ??
      crypto.randomUUID(),
  };

  const result = await emitAndRouteAutomationEvent({
    source: request.headers.get("x-open-agents-event-source") ?? "webhook",
    type: request.headers.get("x-open-agents-event-type") ?? "webhook.received",
    scope: toEventScope(definition.scope),
    subject,
    actor: {
      kind: "public-webhook",
      userAgent: request.headers.get("user-agent") ?? undefined,
    },
    occurredAt: new Date().toISOString(),
    dedupeKey: toDedupeKey(request, automationId, bodyText),
    correlationKey:
      request.headers.get("x-open-agents-correlation-key") ?? subject.id,
    trust: "public",
    connectorId: `custom-webhook:${automationId}`,
    payload,
    rawPayloadRef: bodyText.length > 16_000 ? `inline-sha:${await sha256(bodyText)}` : undefined,
  });

  return Response.json(result, { status: 202 });
}

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
