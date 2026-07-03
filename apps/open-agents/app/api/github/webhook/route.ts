/* oxlint-disable executor/no-try-catch-or-throw, executor/no-promise-catch, executor/no-json-parse -- boundary: GitHub webhook route verifies signatures, parses raw JSON, and best-effort emits automation events before returning HTTP responses */
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import {
  deleteInstallationByInstallationId,
  getInstallationsByInstallationId,
  updateInstallationsByInstallationId,
  upsertInstallation,
} from "@/lib/db/installations";
import { emitAndRouteAutomationEvent } from "@/app/api/automations/_lib/dispatch";
import { startGitHubPullRequestLifecycleWorkflow } from "@/app/workflows/github-pr-lifecycle";
import { getDefaultOrganizationId } from "@/lib/db/organizations";

const installationWebhookSchema = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number(),
    repository_selection: z.enum(["all", "selected"]).optional(),
    html_url: z.string().url().nullable().optional(),
    account: z
      .object({
        login: z.string(),
        type: z.string(),
      })
      .optional(),
  }),
});

const pullRequestWebhookSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }).optional(),
  repository: z.object({
    name: z.string(),
    owner: z.object({
      login: z.string(),
    }),
  }),
  pull_request: z.object({
    number: z.number(),
    merged: z.boolean().optional(),
    html_url: z.string().optional(),
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNestedRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function getGitHubAutomationScopes(payload: unknown) {
  if (!isRecord(payload)) {
    return [{ kind: "org" as const, id: await getDefaultOrganizationId() }];
  }

  const installation = getNestedRecord(payload, "installation");
  const installationId = getNumber(installation?.id);
  if (!installationId) {
    return [{ kind: "org" as const, id: await getDefaultOrganizationId() }];
  }

  const rows = await getInstallationsByInstallationId(installationId);
  if (rows.length === 0) {
    return [{ kind: "org" as const, id: await getDefaultOrganizationId() }];
  }

  return rows.map((row) => ({ kind: "user" as const, id: row.userId }));
}

function getGitHubRepo(payload: unknown) {
  if (!isRecord(payload)) {
    return null;
  }
  const repository = getNestedRecord(payload, "repository");
  const owner = repository ? getNestedRecord(repository, "owner") : undefined;
  const ownerLogin = getString(owner?.login);
  const name = getString(repository?.name);
  if (!ownerLogin || !name) {
    return null;
  }
  return { owner: ownerLogin, name };
}

function getGitHubSubject(event: string, payload: unknown) {
  const repo = getGitHubRepo(payload);
  if (!isRecord(payload)) {
    return {
      kind: "github_event",
      id: event,
      repo,
    };
  }

  if (event === "pull_request") {
    const pr = getNestedRecord(payload, "pull_request");
    const number = getNumber(pr?.number);
    return {
      kind: "github_pull_request",
      id: repo && number ? `${repo.owner}/${repo.name}#${number}` : crypto.randomUUID(),
      url: getString(pr?.html_url),
      repo,
    };
  }

  if (event === "check_run") {
    const checkRun = getNestedRecord(payload, "check_run");
    return {
      kind: "github_check_run",
      id:
        getString(checkRun?.node_id) ??
        String(getNumber(checkRun?.id) ?? crypto.randomUUID()),
      url: getString(checkRun?.html_url),
      repo,
    };
  }

  if (event === "check_suite") {
    const checkSuite = getNestedRecord(payload, "check_suite");
    return {
      kind: "github_check_suite",
      id:
        getString(checkSuite?.node_id) ??
        String(getNumber(checkSuite?.id) ?? crypto.randomUUID()),
      url: getString(checkSuite?.url),
      repo,
    };
  }

  return {
    kind: "github_event",
    id: repo ? `${repo.owner}/${repo.name}:${event}` : event,
    repo,
  };
}

function buildGitHubAutomationPayload(event: string, payload: unknown) {
  if (!isRecord(payload)) {
    return payload;
  }
  if (event === "check_run") {
    const checkRun = getNestedRecord(payload, "check_run");
    return {
      ...payload,
      conclusion: checkRun?.conclusion,
      status: checkRun?.status,
      name: checkRun?.name,
    };
  }
  if (event === "check_suite") {
    const checkSuite = getNestedRecord(payload, "check_suite");
    return {
      ...payload,
      conclusion: checkSuite?.conclusion,
      status: checkSuite?.status,
    };
  }
  return payload;
}

async function emitGitHubAutomationEvent(params: {
  event: string;
  deliveryId: string | null;
  payload: unknown;
}): Promise<string[]> {
  if (params.event === "ping") {
    return [];
  }

  const action = isRecord(params.payload) ? getString(params.payload.action) : undefined;
  const subject = getGitHubSubject(params.event, params.payload);
  const scopes = await getGitHubAutomationScopes(params.payload);
  const results = await Promise.all(
    scopes.map((scope) =>
      emitAndRouteAutomationEvent({
        source: "github",
        type: action ? `${params.event}.${action}` : params.event,
        scope,
        subject: {
          kind: subject.kind,
          id: subject.id,
          url: subject.url,
          repo: subject.repo
            ? { provider: "github", owner: subject.repo.owner, name: subject.repo.name }
            : undefined,
        },
        actor: isRecord(params.payload)
          ? getNestedRecord(params.payload, "sender")
          : undefined,
        occurredAt: new Date().toISOString(),
        dedupeKey:
          params.deliveryId ?? `${params.event}:${subject.id}:${Date.now()}`,
        correlationKey: subject.id,
        trust: "partner",
        connectorId: "github",
        installationId: isRecord(params.payload)
          ? String(getNestedRecord(params.payload, "installation")?.id ?? "")
          : undefined,
        payload: buildGitHubAutomationPayload(params.event, params.payload),
      }),
    ),
  );
  return results.map((result) => result.event.id);
}

function normalizeAccountType(type: string): "User" | "Organization" {
  return type === "Organization" ? "Organization" : "User";
}

function verifySignature(
  payload: string,
  signatureHeader: string,
  secret: string,
): boolean {
  const digest = createHmac("sha256", secret).update(payload).digest("hex");
  const expected = Buffer.from(`sha256=${digest}`);
  const provided = Buffer.from(signatureHeader);

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}

export async function POST(req: Request): Promise<Response> {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return Response.json(
      { error: "GITHUB_WEBHOOK_SECRET is not configured" },
      { status: 500 },
    );
  }

  const event = req.headers.get("x-github-event");
  const deliveryId = req.headers.get("x-github-delivery");
  const signature = req.headers.get("x-hub-signature-256");

  if (!event || !signature) {
    return Response.json({ error: "Missing webhook headers" }, { status: 400 });
  }

  const payloadText = await req.text();
  if (!verifySignature(payloadText, signature, webhookSecret)) {
    return Response.json(
      { error: "Invalid webhook signature" },
      { status: 401 },
    );
  }

  if (event === "ping") {
    return Response.json({ ok: true });
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payloadText);
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  let emittedEventIds: string[] = [];
  try {
    emittedEventIds = await emitGitHubAutomationEvent({
      event,
      deliveryId,
      payload: parsedPayload,
    });
  } catch (error) {
    console.error("[GitHub webhook] Failed to emit automation event:", error);
  }

  if (event === "pull_request") {
    const parsed = pullRequestWebhookSchema.safeParse(parsedPayload);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid webhook payload" },
        { status: 400 },
      );
    }

    if (parsed.data.action !== "closed" && parsed.data.action !== "reopened") {
      return Response.json({
        ok: true,
        event: "pull_request",
        action: parsed.data.action,
        ignored: true,
        emittedEventIds,
      });
    }

    const lifecycleRunId = emittedEventIds[0]
      ? await startGitHubPullRequestLifecycleWorkflow(emittedEventIds[0])
      : null;

    return Response.json({
      ok: true,
      event: "pull_request",
      action: parsed.data.action,
      emittedEventIds,
      lifecycleRunId,
    });
  }

  if (
    event === "check_run" ||
    event === "check_suite" ||
    (event !== "installation" && event !== "installation_repositories")
  ) {
    return Response.json({ ok: true, ignored: true, event });
  }

  const parsed = installationWebhookSchema.safeParse(parsedPayload);
  if (!parsed.success) {
    return Response.json({ error: "Invalid webhook payload" }, { status: 400 });
  }

  const installationId = parsed.data.installation.id;
  const repositorySelection = parsed.data.installation.repository_selection;
  const account = parsed.data.installation.account;
  const installationUrl = parsed.data.installation.html_url ?? null;

  if (event === "installation" && parsed.data.action === "deleted") {
    const deleted = await deleteInstallationByInstallationId(installationId);
    return Response.json({ ok: true, deleted });
  }

  const existing = await getInstallationsByInstallationId(installationId);

  if (existing.length > 0 && account) {
    for (const row of existing) {
      await upsertInstallation({
        userId: row.userId,
        installationId,
        accountLogin: account.login,
        accountType: normalizeAccountType(account.type),
        repositorySelection: repositorySelection ?? row.repositorySelection,
        installationUrl,
      });
    }

    return Response.json({ ok: true, updatedUsers: existing.length });
  }

  if (!repositorySelection && !installationUrl) {
    return Response.json({ ok: true, ignored: true, reason: "no-updates" });
  }

  const updated = await updateInstallationsByInstallationId(installationId, {
    ...(repositorySelection ? { repositorySelection } : {}),
    ...(installationUrl ? { installationUrl } : {}),
  });

  return Response.json({ ok: true, updatedUsers: updated });
}
