/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-unknown-error-message -- boundary: Linear polling adapter normalizes remote GraphQL failures for automation poll evaluator tools */
import "server-only";

import { getSourcePollingIntervalMs } from "@/lib/source-polling/config";
import {
  getAutomationForUser,
  upsertAutomationDefinition,
} from "@/lib/automation/store";
import {
  parseAutomationDefinition,
  stableStringify,
  type AutomationDefinitionInput,
} from "@/lib/automation/types";
import {
  getLinearPollLookbackMs,
  getLinearPollMaxPages,
  getLinearPollOverlapMs,
  getLinearPollingToken,
  getLinearPollPageSize,
} from "./polling-config";

const LINEAR_SOURCE_NAME = "linear";
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

const POLL_LINEAR_ISSUES_QUERY = `
  query OpenAgentsPollLinearIssues($filter: IssueFilter, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        identifier
        title
        description
        url
        updatedAt
        priorityLabel
        project {
          id
          name
          slugId
        }
        team {
          id
          key
          name
        }
        state {
          id
          name
          type
        }
      }
    }
  }
`;

type LinearPollingState = {
  lastPolledAt?: string;
};

type LinearPollingAutomationScope = {
  kind: "system" | "user" | "thread" | "session" | "repo" | "automation";
  id: string;
};

type LinearPollingAutomationResult = {
  status: "emit" | "skip";
  reason?: string;
  state: LinearPollingState & {
    lastIssueCount: number;
  };
  events?: Array<Record<string, unknown>>;
};

type LinearPollingIssue = {
  id: string;
  identifier?: string;
  title: string;
  description?: string;
  url?: string;
  updatedAt?: string;
  priorityLabel?: string;
  project?: {
    id?: string;
    key?: string;
    name?: string;
  };
  team?: {
    id?: string;
    key?: string;
    name?: string;
  };
  state?: {
    name?: string;
    type?: string;
  };
};

type LinearIssuesPage = {
  issues: LinearPollingIssue[];
  hasNextPage: boolean;
  endCursor?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNestedRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function parseLinearPollingIssue(data: unknown): LinearPollingIssue | null {
  if (!isRecord(data)) {
    return null;
  }

  const id = getString(data.id);
  const title = getString(data.title);
  if (!id || !title) {
    return null;
  }

  const project = getNestedRecord(data, "project");
  const team = getNestedRecord(data, "team");
  const state = getNestedRecord(data, "state");

  return {
    id,
    identifier: getString(data.identifier),
    title,
    description: getString(data.description),
    url: getString(data.url),
    updatedAt: getString(data.updatedAt),
    priorityLabel: getString(data.priorityLabel),
    project: project
      ? {
          id: getString(project.id),
          key: getString(project.slugId),
          name: getString(project.name),
        }
      : undefined,
    team: team
      ? {
          id: getString(team.id),
          key: getString(team.key),
          name: getString(team.name),
        }
      : undefined,
    state: state
      ? {
          name: getString(state.name),
          type: getString(state.type),
        }
      : undefined,
  };
}

function parseLinearIssuesResponse(responseJson: unknown): LinearIssuesPage {
  if (!isRecord(responseJson)) {
    throw new Error("Linear returned a non-object GraphQL response");
  }

  const errors = responseJson.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors
      .map((error) => (isRecord(error) ? getString(error.message) : undefined))
      .filter((message): message is string => typeof message === "string");
    throw new Error(
      `Linear GraphQL error${messages.length === 1 ? "" : "s"}: ${
        messages.join("; ") || "unknown error"
      }`,
    );
  }

  const data = getNestedRecord(responseJson, "data");
  const issues = data ? getNestedRecord(data, "issues") : undefined;
  const nodes = issues?.nodes;
  if (!Array.isArray(nodes)) {
    return { issues: [], hasNextPage: false };
  }

  const pageInfo = issues ? getNestedRecord(issues, "pageInfo") : undefined;
  return {
    issues: nodes
      .map(parseLinearPollingIssue)
      .filter((issue): issue is LinearPollingIssue => issue !== null),
    hasNextPage: pageInfo?.hasNextPage === true,
    endCursor: getString(pageInfo?.endCursor),
  };
}

function getPollingSince(state: LinearPollingState | null, now: Date): Date {
  const lastPolledAtMs = state?.lastPolledAt
    ? Date.parse(state.lastPolledAt)
    : Number.NaN;
  if (Number.isFinite(lastPolledAtMs)) {
    return new Date(Math.max(0, lastPolledAtMs - getLinearPollOverlapMs()));
  }

  return new Date(Math.max(0, now.getTime() - getLinearPollLookbackMs()));
}

async function fetchLinearIssuesUpdatedSince(
  since: Date,
): Promise<LinearPollingIssue[]> {
  const token = getLinearPollingToken();
  if (!token) {
    throw new Error(
      "LINEAR_API_KEY or LINEAR_ACCESS_TOKEN is required for Linear polling",
    );
  }

  const issues: LinearPollingIssue[] = [];
  let after: string | undefined;

  for (let page = 0; page < getLinearPollMaxPages(); page += 1) {
    const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: POLL_LINEAR_ISSUES_QUERY,
        variables: {
          after,
          filter: {
            updatedAt: {
              gte: since.toISOString(),
            },
          },
          first: getLinearPollPageSize(),
        },
      }),
    });

    const responseJson = (await response.json()) as unknown;
    if (!response.ok) {
      throw new Error(
        `Linear polling failed with HTTP ${response.status}: ${JSON.stringify(
          responseJson,
        )}`,
      );
    }

    const pageResult = parseLinearIssuesResponse(responseJson);
    issues.push(...pageResult.issues);
    if (!pageResult.hasNextPage) {
      return issues;
    }

    after = pageResult.endCursor;
    if (!after) {
      return issues;
    }
  }

  throw new Error(
    `Linear polling reached OPEN_AGENTS_LINEAR_POLL_MAX_PAGES=${getLinearPollMaxPages()} before exhausting results`,
  );
}

function getLinearPollingOwnerUserId(): string {
  return process.env.OPEN_AGENTS_LINEAR_USER_ID?.trim() || "local-user";
}

function getLinearPollingAutomationId(userId = getLinearPollingOwnerUserId()): string {
  return `linear-polling-source-${userId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function toLinearPollingScope(userId = getLinearPollingOwnerUserId()) {
  return process.env.OPEN_AGENTS_LINEAR_USER_ID
    ? ({ kind: "user" as const, id: userId })
    : ({ kind: "system" as const, id: "global" });
}

function buildLinearPollingEvaluatorCode(): string {
  return [
    "return await tools.open_agents_automations.pollLinearIssues({",
    "  state,",
    "  now,",
    "  scope: automation.scope,",
    "});",
  ].join("\n");
}

export function buildLinearPollingAutomationDefinition(
  userId = getLinearPollingOwnerUserId(),
): AutomationDefinitionInput {
  const scope = toLinearPollingScope(userId);
  return {
    id: getLinearPollingAutomationId(userId),
    name: "Linear polling source",
    description:
      "Database-backed automation poll trigger that emits Linear issue update events into the event ledger.",
    enabled: true,
    scope,
    owner: { kind: "user", id: userId },
    identity: { kind: "user", userId },
    triggers: [
      {
        kind: "poll",
        schedule: {
          kind: "interval",
          everyMs: getSourcePollingIntervalMs(),
        },
        evaluator: {
          code: buildLinearPollingEvaluatorCode(),
          timeoutMs: 60_000,
        },
      },
    ],
    conditions: [],
    concurrency: { key: "event", onConflict: "skip" },
    correlation: { key: "none" },
    policy: {
      autonomy: "read-only",
      budget: { maxDurationMs: 60_000, maxModelSteps: 1 },
      executorTools: [],
      builtInTools: [],
      memory: "none",
      approvals: [],
    },
    action: {
      kind: "notify",
      destination: "inbox",
      message: "Linear polling source emitted events.",
    },
    outputs: [{ kind: "inbox" }],
  };
}

function comparableDefinition(input: unknown): string {
  const parsed = parseAutomationDefinition(input);
  const { version: _version, ...definition } = parsed;
  return stableStringify(definition);
}

export async function ensureLinearPollingAutomation() {
  const userId = getLinearPollingOwnerUserId();
  const definition = buildLinearPollingAutomationDefinition(userId);
  const automationId = getLinearPollingAutomationId(userId);
  const current = await getAutomationForUser({ automationId, userId });
  if (
    current?.version &&
    comparableDefinition(current.version.definitionJson) ===
      comparableDefinition(definition)
  ) {
    return { automation: current.automation, version: current.version };
  }

  return upsertAutomationDefinition({
    userId,
    definition,
    changeSummary: "Ensure Linear polling source automation",
  });
}

export async function pollLinearIssuesForAutomation(params: {
  state?: unknown;
  now?: string;
  scope?: unknown;
}): Promise<LinearPollingAutomationResult> {
  const now = params.now ? new Date(params.now) : new Date();
  const state = isRecord(params.state)
    ? (params.state as LinearPollingState)
    : null;
  const since = getPollingSince(state, now);
  const issues = await fetchLinearIssuesUpdatedSince(since);
  const scope = isRecord(params.scope)
    ? {
        kind:
          typeof params.scope.kind === "string"
            ? params.scope.kind
            : toLinearPollingScope().kind,
        id:
          typeof params.scope.id === "string"
            ? params.scope.id
            : toLinearPollingScope().id,
      }
    : toLinearPollingScope();

  const events = issues.map((issue): Record<string, unknown> => {
    const marker = issue.updatedAt ?? "unknown";
    return {
      source: LINEAR_SOURCE_NAME,
      type: "issue.updated",
      scope: scope as LinearPollingAutomationScope,
      subject: {
        kind: "linear_issue",
        id: issue.identifier ?? issue.id,
        url: issue.url,
      },
      actor: { kind: "linear-poller" },
      occurredAt: issue.updatedAt ?? now.toISOString(),
      dedupeKey: `linear-poll:${issue.id}:${marker}`,
      correlationKey: `linear:${issue.id}`,
      trust: "partner",
      connectorId: "linear-polling",
      payload: {
        action: "updated",
        data: issue,
        type: "Issue",
        webhookTimestamp: now.getTime(),
      },
    };
  });

  return {
    status: events.length > 0 ? "emit" : "skip",
    reason: events.length > 0 ? undefined : "No Linear issues updated since the last poll window.",
    state: {
      lastPolledAt: now.toISOString(),
      lastIssueCount: issues.length,
    },
    ...(events.length > 0 ? { events } : {}),
  };
}
