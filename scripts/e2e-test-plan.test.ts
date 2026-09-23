import assert from "node:assert/strict";
import { test } from "node:test";
import { patternForTarget, scenarios } from "../e2e/test-plan.ts";

test("shared files run only their scheduled scenarios for each target", () => {
  const selfHost = new RegExp(patternForTarget("self-host", "all", ""));
  const cloud = new RegExp(patternForTarget("cloud", "all", ""));
  assert.equal(selfHost.test(`Organization groups ${scenarios.groups.title}`), true);
  assert.equal(selfHost.test(`Organization groups ${scenarios.groupsIsolation.title}`), false);
  assert.equal(cloud.test(`Organization groups ${scenarios.groupsIsolation.title}`), true);
});

test("a caller's name filter narrows the declared target scenarios", () => {
  const pattern = new RegExp(patternForTarget("self-host", "all", "App copies"));
  assert.equal(pattern.test(`App copies ${scenarios.appCopies.title}`), true);
  assert.equal(pattern.test(`Organization groups ${scenarios.groups.title}`), false);
  const excluded = new RegExp(patternForTarget("self-host", "all", "^(?!.*App copies)"));
  assert.equal(excluded.test(`App copies ${scenarios.appCopies.title}`), false);
  assert.equal(excluded.test(`Organization groups ${scenarios.groups.title}`), true);
});
