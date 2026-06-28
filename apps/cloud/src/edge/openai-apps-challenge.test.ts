import { describe, expect, it } from "@effect/vitest";

import {
  OPENAI_APPS_CHALLENGE_PATH,
  OPENAI_APPS_CHALLENGE_TOKEN,
  isOpenAiAppsChallengePath,
  openAiAppsChallengeResponse,
} from "./openai-apps-challenge";

describe("isOpenAiAppsChallengePath", () => {
  it("claims the OpenAI Apps verification challenge path", () => {
    expect(isOpenAiAppsChallengePath(OPENAI_APPS_CHALLENGE_PATH)).toBe(true);
  });

  it("does not claim sibling well-known paths", () => {
    expect(isOpenAiAppsChallengePath("/.well-known/openai-apps-challenge/extra")).toBe(false);
    expect(isOpenAiAppsChallengePath("/.well-known/oauth-protected-resource/mcp")).toBe(false);
  });
});

describe("openAiAppsChallengeResponse", () => {
  it("serves the exact verification token as plain text", async () => {
    const response = openAiAppsChallengeResponse();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe(OPENAI_APPS_CHALLENGE_TOKEN);
  });
});
