import assert from "node:assert/strict";
import { test } from "node:test";
import { filesForTarget, patternForTarget, scenarios } from "../e2e/test-plan.ts";

test("anchored scenario filters select the same cases after Vitest adds suite names", () => {
  const filter = "^MCP subscriptions survive ";
  const pattern = new RegExp(patternForTarget("cloud", "all", filter, "attached"));
  assert.equal(filesForTarget("cloud", "all", "attached", filter).length, 3);
  for (const scenario of [
    scenarios.mcpMemory,
    scenarios.mcpMemoryShared,
    scenarios.mcpMemoryBurst,
  ]) {
    assert.ok(pattern.test(`MCP memory ${scenario.title}`), scenario.title);
  }
  assert.equal(pattern.test(`Cloud ${scenarios.cloud.title}`), false);
});

test("exclusions and target applicability survive suite prefixes", () => {
  const filter = "^(?!.*MCP subscriptions survive)";
  const pattern = new RegExp(patternForTarget("cloud", "all", filter, "attached"));
  assert.equal(pattern.test(`MCP memory ${scenarios.mcpMemory.title}`), false);
  assert.ok(pattern.test(`Cloud ${scenarios.cloud.title}`));
  const managed = new RegExp(
    patternForTarget("cloud", "all", "^MCP subscriptions survive ", "managed"),
  );
  assert.equal(managed.test(`MCP memory ${scenarios.mcpMemory.title}`), false);
});
