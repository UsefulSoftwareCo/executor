import { describe, expect, it } from "@effect/vitest";

import { graphqlConnectionName } from "./defaults";

describe("graphqlConnectionName", () => {
  it("is deterministic per integration + owner", () => {
    expect(String(graphqlConnectionName("github_com", "user"))).toBe("githubComUser");
    expect(String(graphqlConnectionName("github_com", "org"))).toBe("githubComOrg");
  });
});
