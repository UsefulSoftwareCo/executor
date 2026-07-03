/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: durable GitHub lifecycle workflow translates malformed event payloads into stable workflow failures */
import { start } from "workflow/api";

type GitHubPrLifecycleResult = {
  eventId: string;
  action: string;
  prStatus: "open" | "closed" | "merged";
  matchedSessions: number;
  updatedSessions: number;
  archivedSessions: number;
};

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

async function applyGitHubPullRequestLifecycleStep(
  eventId: string,
): Promise<GitHubPrLifecycleResult> {
  "use step";
  const { and, eq, sql } = await import("drizzle-orm");
  const { db } = await import("@/lib/db/client");
  const { sessions } = await import("@/lib/db/schema");
  const { updateSession } = await import("@/lib/db/sessions");
  const { archiveSession } = await import("@/lib/sandbox/archive-session");
  const { getAutomationEventById } = await import("@/lib/automation/store");

  const event = await getAutomationEventById(eventId);
  if (!event || event.source !== "github" || !event.type.startsWith("pull_request.")) {
    throw new Error("GitHub pull request lifecycle event not found");
  }

  const payload = event.payloadJson;
  if (!isRecord(payload)) {
    throw new Error("GitHub pull request payload is not an object");
  }

  const action = getString(payload.action) ?? event.type.replace("pull_request.", "");
  if (action !== "closed" && action !== "reopened") {
    return {
      eventId,
      action,
      prStatus: "open",
      matchedSessions: 0,
      updatedSessions: 0,
      archivedSessions: 0,
    };
  }

  const repository = getNestedRecord(payload, "repository");
  const owner = repository ? getNestedRecord(repository, "owner") : undefined;
  const pullRequest = getNestedRecord(payload, "pull_request");
  const repoOwner = getString(owner?.login);
  const repoName = getString(repository?.name);
  const prNumber = getNumber(pullRequest?.number);
  if (!repoOwner || !repoName || prNumber === undefined) {
    throw new Error("GitHub pull request payload is missing repo or PR number");
  }

  const prStatus =
    action === "closed"
      ? pullRequest?.merged === true
        ? "merged"
        : "closed"
      : "open";

  const linkedSessions = await db.query.sessions.findMany({
    where: and(
      sql`lower(${sessions.repoOwner}) = ${repoOwner.toLowerCase()}`,
      sql`lower(${sessions.repoName}) = ${repoName.toLowerCase()}`,
      eq(sessions.prNumber, prNumber),
    ),
  });

  let updatedSessions = 0;
  let archivedSessions = 0;

  for (const sessionRecord of linkedSessions) {
    const shouldArchive =
      action === "closed" && sessionRecord.status !== "archived";
    const updatePayload: Parameters<typeof updateSession>[1] = {};

    if (sessionRecord.prStatus !== prStatus) {
      updatePayload.prStatus = prStatus;
    }

    if (shouldArchive) {
      const archived = await archiveSession(sessionRecord.id, {
        currentSession: sessionRecord,
        update: updatePayload,
        logPrefix: "[GitHub PR lifecycle]",
      });
      if (archived.session) {
        updatedSessions += 1;
      }
      if (archived.archiveTriggered) {
        archivedSessions += 1;
      }
      continue;
    }

    if (Object.keys(updatePayload).length > 0) {
      const updated = await updateSession(sessionRecord.id, updatePayload);
      if (updated) {
        updatedSessions += 1;
      }
    }
  }

  return {
    eventId,
    action,
    prStatus,
    matchedSessions: linkedSessions.length,
    updatedSessions,
    archivedSessions,
  };
}

applyGitHubPullRequestLifecycleStep.maxRetries = 3;

export async function githubPullRequestLifecycleWorkflow(eventId: string) {
  "use workflow";
  return applyGitHubPullRequestLifecycleStep(eventId);
}

export async function startGitHubPullRequestLifecycleWorkflow(eventId: string) {
  const run = await start(githubPullRequestLifecycleWorkflow, [eventId]);
  return run.runId;
}
