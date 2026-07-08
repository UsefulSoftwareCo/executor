import { describe, expect, it } from "@effect/vitest";

import { integration } from "./authoring";

describe("authoring integration builder", () => {
  it("returns immutable fluent declarations", () => {
    const base = integration("gmail");
    const many = base.array().describe("Inbox accounts");
    const all = many.all();

    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(many)).toBe(true);
    expect(base).toMatchObject({
      kind: "integration",
      slug: "gmail",
      mode: "one",
      allConnections: false,
    });
    expect(many).toMatchObject({
      kind: "integration",
      slug: "gmail",
      mode: "many",
      allConnections: false,
      description: "Inbox accounts",
    });
    expect(all).toMatchObject({
      kind: "integration",
      slug: "gmail",
      mode: "many",
      allConnections: true,
      description: "Inbox accounts",
    });
    expect(base).not.toBe(many);
    expect(many).not.toBe(all);
  });
});
