import { describe, expect, test } from "bun:test";
import {
  parseAutomationDefinition,
  parseAutomationEventInput,
  type AutomationDefinitionInput,
} from "./types";

function definition(scope: AutomationDefinitionInput["scope"]): AutomationDefinitionInput {
  return {
    name: "Canonical scope automation",
    enabled: true,
    scope,
    owner: { kind: "user", id: "user-1" },
    identity: { kind: "user", userId: "user-1" },
    triggers: [{ kind: "manual" }],
    action: {
      kind: "notify",
      destination: "inbox",
      message: "done",
    },
  };
}

describe("automation scope schemas", () => {
  test("accept user, group, and org automation scopes", () => {
    expect(parseAutomationDefinition(definition({ kind: "user", id: "user-1" })).scope).toEqual({
      kind: "user",
      id: "user-1",
    });
    expect(parseAutomationDefinition(definition({ kind: "group", id: "group-1" })).scope).toEqual({
      kind: "group",
      id: "group-1",
    });
    expect(parseAutomationDefinition(definition({ kind: "org", id: "org-1" })).scope).toEqual({
      kind: "org",
      id: "org-1",
    });
  });

  test("rejects legacy automation scopes at runtime boundaries", () => {
    for (const kind of ["system", "thread", "session", "repo", "automation", "external-thread"]) {
      expect(() =>
        parseAutomationDefinition({
          ...definition({ kind: "user", id: "user-1" }),
          scope: { kind, id: "legacy" },
        }),
      ).toThrow();
    }
  });

  test("rejects legacy event scopes at runtime boundaries", () => {
    for (const kind of ["system", "thread", "session", "repo", "automation"]) {
      expect(() =>
        parseAutomationEventInput({
          source: "test",
          type: "test.event",
          scope: { kind, id: "legacy" },
          subject: { kind: "test", id: "subject" },
          dedupeKey: `legacy:${kind}`,
        }),
      ).toThrow();
    }
  });
});
