import { describe, expect, it } from "@effect/vitest";

import { parseChallenges } from "./www-authenticate";

describe("authentication challenge metadata", () => {
  it("keeps a Bearer metadata URL separate from other schemes and quoted text", () => {
    const challenges = parseChallenges(
      'Basic realm="resource_metadata=wrong", resource_metadata="https://wrong.example", Bearer realm="OAuth", resource_metadata="https://api.example/metadata"',
    );
    expect(
      challenges
        ?.find((challenge) => challenge.scheme === "bearer")
        ?.params.get("resource_metadata"),
    ).toBe("https://api.example/metadata");
  });

  it("accepts the unquoted URL form emitted by providers", () => {
    const challenges = parseChallenges("bearer resource_metadata=https://api.example/metadata");
    expect(challenges?.[0]?.params.get("resource_metadata")).toBe("https://api.example/metadata");
  });

  it("rejects unterminated quoted metadata", () => {
    expect(parseChallenges('Bearer resource_metadata="https://api.example/metadata')).toBeNull();
  });
});
