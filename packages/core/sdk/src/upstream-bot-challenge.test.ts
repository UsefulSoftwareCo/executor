import { describe, expect, it } from "@effect/vitest";

import { botChallengeToolFailure, detectBotChallenge } from "./upstream-bot-challenge";

describe("detectBotChallenge", () => {
  it("detects a Cloudflare challenge and carries its Ray ID", () => {
    expect(
      detectBotChallenge({
        headers: { "cf-mitigated": "challenge", "cf-ray": "8f1a2b3c4d5e6f70-SJC" },
      }),
    ).toEqual({ provider: "cloudflare", rayId: "8f1a2b3c4d5e6f70-SJC" });
  });

  it("matches header names and the value case-insensitively", () => {
    expect(detectBotChallenge({ headers: { "CF-Mitigated": " Challenge " } })).toEqual({
      provider: "cloudflare",
    });
  });

  it("does not classify without the cf-mitigated challenge header", () => {
    // A Cloudflare-fronted origin's own 403 carries cf-ray but no mitigation.
    expect(
      detectBotChallenge({ headers: { server: "cloudflare", "cf-ray": "8f1a2b3c4d5e6f70-SJC" } }),
    ).toBeNull();
    expect(detectBotChallenge({ headers: { "cf-mitigated": "block" } })).toBeNull();
    expect(detectBotChallenge({})).toBeNull();
  });
});

describe("botChallengeToolFailure", () => {
  it("is a non-authentication failure that tells the agent the credential was not checked", () => {
    const result = botChallengeToolFailure({
      integration: { id: "example_api", scope: "user" },
      status: 403,
      detection: { provider: "cloudflare", rayId: "8f1a2b3c4d5e6f70-SJC" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "upstream_bot_challenge",
        status: 403,
        retryable: false,
        message: expect.stringMatching(/Ray ID 8f1a2b3c4d5e6f70-SJC.*credential was not checked/),
        details: {
          category: "upstream_protection",
          integration: { id: "example_api", scope: "user" },
          upstream: {
            status: 403,
            provider: "cloudflare",
            mitigation: "challenge",
            rayId: "8f1a2b3c4d5e6f70-SJC",
          },
        },
      },
    });
    const recovery = (result as { error: { details: { recovery: Record<string, string> } } }).error
      .details.recovery;
    expect(
      recovery.createConnectionTool,
      "no reconnect hint: a new credential meets the same challenge",
    ).toBeUndefined();
  });
});
