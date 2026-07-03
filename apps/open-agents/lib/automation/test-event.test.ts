import { describe, expect, test } from "bun:test";
import { buildAutomationTestEventInput } from "./test-event";
import type { AutomationDefinition } from "./types";

const definition: AutomationDefinition = {
  name: "Manual test",
  enabled: true,
  scope: { kind: "org", id: "org-1" },
  owner: { kind: "user", id: "user-1" },
  identity: { kind: "user", userId: "user-1" },
  triggers: [{ kind: "event", source: "manual", type: "manual.received" }],
  conditions: [],
  concurrency: { key: "event", onConflict: "skip" },
  correlation: { key: "event" },
  policy: {
    autonomy: "read-only",
    budget: {},
    executorTools: [],
    builtInTools: [],
    memory: "none",
    approvals: [],
  },
  action: { kind: "notify", destination: "inbox", message: "done" },
  outputs: [],
};

describe("buildAutomationTestEventInput", () => {
  test("uses the automation's canonical scope by default", () => {
    const event = buildAutomationTestEventInput({
      automationId: "automation-1",
      userId: "user-1",
      definition,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(event.scope).toEqual({ kind: "org", id: "org-1" });
  });

  test("does not emit legacy scope overrides from request bodies", () => {
    const event = buildAutomationTestEventInput({
      automationId: "automation-1",
      userId: "user-1",
      definition,
      body: { scope: { kind: "session", id: "session-1" } },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(event.scope).toEqual({ kind: "org", id: "org-1" });
  });
});
