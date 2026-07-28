import { describe, expect, it } from "@effect/vitest";
import { PROVIDED_GLOBAL_NAMES } from "@executor-js/execution";

import { PROVIDED_SCOPE_NAMES } from "./component-runtime";

// The `create-artifact` tool rejects code that redeclares a name the shell already
// binds. That guard lives in the MCP host (which must not import React), so the
// name list is generated into the execution package by
// `scripts/gen-provided-globals.ts`. This test is the pin: add a component to
// `components.ts` without regenerating and it fails here rather than silently
// letting a model shadow a real binding at render time.
describe("provided globals", () => {
  it("matches the scope the iframe actually binds", () => {
    expect([...PROVIDED_GLOBAL_NAMES].sort()).toEqual([...PROVIDED_SCOPE_NAMES].sort());
  });

  it("covers the names the shell is built around", () => {
    for (const name of [
      "React",
      "useState",
      "useQuery",
      "useInfiniteQuery",
      "infiniteQueryOptions",
      "tools",
      "Card",
      "cn",
    ]) {
      expect(PROVIDED_SCOPE_NAMES).toContain(name);
    }
  });

  // The decision this branch encodes: artifact code is purely declarative
  // `tools.*`. `run` was the escape hatch for arbitrary code and is gone from
  // the model-facing surface entirely — re-adding it to the scope must fail
  // here, not quietly reopen the hole.
  it("binds no arbitrary-code escape hatch", () => {
    expect(PROVIDED_SCOPE_NAMES).not.toContain("run");
    expect(PROVIDED_SCOPE_NAMES).not.toContain("eval");
  });
});
