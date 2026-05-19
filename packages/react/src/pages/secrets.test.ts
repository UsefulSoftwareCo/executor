import { describe, expect, it } from "@effect/vitest";
import { ScopeId } from "@executor-js/sdk/shared";

import { secretFormScopeId } from "./secrets";

describe("secretFormScopeId", () => {
  it("uses the current route scope without an agent handoff target", () => {
    const current = ScopeId.make("current-scope");

    expect(secretFormScopeId(current)).toBe(current);
  });

  it("uses the agent handoff scope when one is present", () => {
    expect(secretFormScopeId(ScopeId.make("current-scope"), { scope: "target-scope" })).toBe(
      "target-scope",
    );
  });
});
