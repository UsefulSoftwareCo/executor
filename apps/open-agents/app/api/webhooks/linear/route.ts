/* oxlint-disable executor/no-try-catch-or-throw, executor/no-json-parse -- boundary: Linear webhook route verifies signatures and parses external JSON */
import { createHmac, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { emitAndRouteAutomationEvent } from "@/lib/automation/dispatch";

const LINEAR_SIGNATURE_HEADER = "linear-signature";
const LINEAR_WEBHOOK_TOLERANCE_MS = 60 * 1000;

type LinearWebhookPayload = {
  action?: string;
  data?: unknown;
  organizationId?: string;
  type?: string;
  url?: string;
  webhookTimestamp?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function verifyLinearSignature(params: {
  body: string;
  secret: string;
  signature: string;
}): boolean {
  const expected = createHmac("sha256", params.secret)
    .update(params.body)
    .digest();
  const provided = Buffer.from(params.signature, "hex");

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}

function parseLinearWebhookPayload(body: string): LinearWebhookPayload | null {
  const payload = JSON.parse(body) as unknown;
  if (!isRecord(payload)) {
    return null;
  }

  return payload;
}

function isRecentLinearWebhook(payload: LinearWebhookPayload): boolean {
  return (
    typeof payload.webhookTimestamp === "number" &&
    Math.abs(Date.now() - payload.webhookTimestamp) <= LINEAR_WEBHOOK_TOLERANCE_MS
  );
}

export async function POST(request: Request) {
  const webhookSecret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return new Response("LINEAR_WEBHOOK_SECRET is not configured", { status: 500 });
  }

  const signature = request.headers.get(LINEAR_SIGNATURE_HEADER);
  if (!signature) {
    return new Response("Missing Linear signature", { status: 400 });
  }

  const body = await request.text();
  if (!verifyLinearSignature({ body, secret: webhookSecret, signature })) {
    return new Response("Invalid Linear signature", { status: 401 });
  }

  const payload = parseLinearWebhookPayload(body);
  if (!payload || !isRecentLinearWebhook(payload)) {
    return new Response("Invalid Linear webhook payload", { status: 400 });
  }

  after(async () => {
    await emitLinearAutomationEvent(payload);
  });

  return Response.json({ ok: true });
}

async function emitLinearAutomationEvent(payload: LinearWebhookPayload) {
  const data = isRecord(payload.data) ? payload.data : {};
  const issueId = getString(data.identifier) ?? getString(data.id) ?? crypto.randomUUID();
  const action = getString(payload.action) ?? "event";
  const type = getString(payload.type) ?? "linear";

  await emitAndRouteAutomationEvent({
    source: "linear",
    type: `${type.toLowerCase()}.${action}`,
    scope: process.env.OPEN_AGENTS_LINEAR_USER_ID
      ? { kind: "user", id: process.env.OPEN_AGENTS_LINEAR_USER_ID }
      : { kind: "system", id: "global" },
    subject: {
      kind: type === "Issue" ? "linear_issue" : "linear_event",
      id: issueId,
      url: getString(data.url),
    },
    actor: { kind: "linear-webhook" },
    occurredAt: new Date().toISOString(),
    dedupeKey: `linear-webhook:${issueId}:${String(payload.webhookTimestamp)}`,
    correlationKey: `linear:${getString(data.id) ?? issueId}`,
    trust: "partner",
    connectorId: "linear-webhook",
    payload,
  });
}
