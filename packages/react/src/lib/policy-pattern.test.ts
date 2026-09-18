import { describe, expect, it } from "@effect/vitest";

import { accountPolicyPattern, toPolicyPattern } from "./policy-pattern";

describe("policy pattern bridges", () => {
  it("wildcards owner and connection for the connection-agnostic tree", () => {
    expect(toPolicyPattern("slack.conversations.history")).toBe("slack.*.*.conversations.history");
    expect(toPolicyPattern("slack.conversations.*")).toBe("slack.*.*.conversations.*");
    expect(toPolicyPattern("slack.*")).toBe("slack.*");
    expect(toPolicyPattern("*")).toBe("*");
  });

  it("pins owner and connection for a row inside an account section", () => {
    const forBot = accountPolicyPattern("org", "bot");
    expect(forBot("slack.conversations.history")).toBe("slack.org.bot.conversations.history");
    expect(forBot("slack.conversations.*")).toBe("slack.org.bot.conversations.*");
    expect(forBot("slack.*")).toBe("slack.org.bot.*");
    expect(forBot("slack")).toBe("slack.org.bot.*");
    expect(forBot("*")).toBe("*");
  });
});
