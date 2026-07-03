import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
mock.module("@/lib/automation/store", () => ({
  appendAutomationTimeline: mock(async () => undefined),
  getAutomationForUser: mock(async () => null),
  upsertAutomationDefinition: mock(async () => ({
    automation: { id: "linear-polling-source-local-user" },
    version: { id: "version-1" },
  })),
}));

const {
  buildLinearPollingAutomationDefinition,
  pollLinearIssuesForAutomation,
} = await import("./polling");

const originalFetch = globalThis.fetch;
const originalEnv = {
  LINEAR_API_KEY: process.env.LINEAR_API_KEY,
  OPEN_AGENTS_LINEAR_USER_ID: process.env.OPEN_AGENTS_LINEAR_USER_ID,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("Linear automation polling", () => {
  test("builds a registered poll-trigger automation definition", () => {
    const definition = buildLinearPollingAutomationDefinition("linear-owner");
    const [trigger] = definition.triggers ?? [];

    expect(definition.id).toBe("linear-polling-source-linear-owner");
    expect(trigger).toMatchObject({
      kind: "poll",
      schedule: { kind: "interval" },
    });
    expect(JSON.stringify(trigger)).toContain(
      "tools.open_agents_automations.pollLinearIssues",
    );
  });

  test("returns ledger-ready Linear issue events and durable poll state", async () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    const fetchReplacement = Object.assign(
      mock(async () =>
        Response.json({
          data: {
            issues: {
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
              nodes: [
                {
                  id: "issue-uuid-1",
                  identifier: "ENG-42",
                  title: "Fix flaky build",
                  url: "https://linear.app/acme/issue/ENG-42",
                  updatedAt: "2026-05-23T07:00:00.000Z",
                  priorityLabel: "High",
                  team: { id: "team-1", key: "ENG", name: "Engineering" },
                  state: { id: "state-1", name: "Triage", type: "started" },
                },
              ],
            },
          },
        }),
      ),
      { preconnect: originalFetch.preconnect.bind(originalFetch) },
    );
    globalThis.fetch = fetchReplacement;

    const result = await pollLinearIssuesForAutomation({
      now: "2026-05-23T07:05:00.000Z",
      state: { lastPolledAt: "2026-05-23T07:00:30.000Z" },
      scope: { kind: "user", id: "linear-owner" },
    });

    expect(result.status).toBe("emit");
    expect(result.state).toEqual({
      lastPolledAt: "2026-05-23T07:05:00.000Z",
      lastIssueCount: 1,
    });
    expect(result.events?.[0]).toMatchObject({
      source: "linear",
      type: "issue.updated",
      scope: { kind: "user", id: "linear-owner" },
      subject: {
        kind: "linear_issue",
        id: "ENG-42",
        url: "https://linear.app/acme/issue/ENG-42",
      },
      dedupeKey: "linear-poll:issue-uuid-1:2026-05-23T07:00:00.000Z",
      correlationKey: "linear:issue-uuid-1",
      trust: "partner",
      connectorId: "linear-polling",
    });
  });
});
