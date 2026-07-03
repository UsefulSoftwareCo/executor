import { describe, expect, test } from "bun:test";
import {
  blockedBuiltInToolsForAutomationPolicy,
  filterBuiltInToolsForAutomationPolicy,
} from "./policy";
import type { AutomationPolicy } from "./types";

function policy(
  autonomy: AutomationPolicy["autonomy"],
  builtInTools: AutomationPolicy["builtInTools"],
): AutomationPolicy {
  return {
    autonomy,
    budget: {},
    executorTools: [],
    builtInTools,
    memory: "none",
    approvals: [],
  };
}

describe("automation policy tool filtering", () => {
  test("removes mutating tools from read-only automation policies", () => {
    const input = policy("read-only", ["read_file", "grep", "write_file", "bash", "web_fetch"]);

    expect(filterBuiltInToolsForAutomationPolicy(input)).toEqual(["read_file", "grep"]);
    expect(blockedBuiltInToolsForAutomationPolicy(input)).toEqual([
      "write_file",
      "bash",
      "web_fetch",
    ]);
  });

  test("allows branch-pr automations to use coding tools", () => {
    const input = policy("branch-pr", ["read_file", "write_file", "bash", "web_fetch"]);

    expect(filterBuiltInToolsForAutomationPolicy(input)).toEqual([
      "read_file",
      "write_file",
      "bash",
      "web_fetch",
    ]);
    expect(blockedBuiltInToolsForAutomationPolicy(input)).toEqual([]);
  });
});
