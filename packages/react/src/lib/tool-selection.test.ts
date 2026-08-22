import { describe, expect, it } from "@effect/vitest";

import { toolSelectionFromSearch, toolSelectionSearch } from "./integration-detail-tabs";

describe("tool selection search state", () => {
  it("round-trips a selected tool through URL search parameters", () => {
    const selected = "org:githubPrimary:github.repos.createIssue";
    const query = new URLSearchParams(toolSelectionSearch(selected));

    expect(toolSelectionFromSearch(Object.fromEntries(query))).toBe(selected);
  });

  it("clears selection and ignores stale or malformed values", () => {
    expect(toolSelectionSearch(null)).toEqual({ tool: undefined });
    expect(toolSelectionFromSearch({ tool: "" })).toBeNull();
    expect(toolSelectionFromSearch({ tool: 42 })).toBeNull();
  });
});
