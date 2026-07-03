import { describe, expect, mock, test } from "bun:test";

mock.module("./client", () => ({
  db: {},
}));

const userPreferencesModulePromise = import("./user-preferences");

describe("toUserPreferencesData", () => {
  test("returns defaults when row is undefined", async () => {
    const { toUserPreferencesData } = await userPreferencesModulePromise;

    expect(toUserPreferencesData()).toEqual({
      defaultModelId: "anthropic/claude-sonnet-4.6",
      defaultSubagentModelId: null,
      defaultSandboxType: "vercel",
      defaultDiffMode: "unified",
      autoCommitPush: false,
      autoCreatePr: false,
      alertsEnabled: true,
      alertSoundEnabled: true,
      publicUsageEnabled: false,
      globalSkillRefs: [],
      defaultAgentName: "default",
      modelVariants: [],
      enabledModelIds: [],
    });
  });

  test("normalizes invalid sandbox and diff mode values to defaults", async () => {
    const { toUserPreferencesData } = await userPreferencesModulePromise;

    const result = toUserPreferencesData({
      defaultModelId: "openai/gpt-5",
      defaultSubagentModelId: "openai/gpt-5-mini",
      defaultSandboxType: "invalid" as never,
      defaultDiffMode: "invalid" as never,
      autoCommitPush: false,
      autoCreatePr: false,
      alertsEnabled: true,
      alertSoundEnabled: true,
      publicUsageEnabled: false,
      globalSkillRefs: [],
      defaultAgentName: "default",
      modelVariants: [],
      enabledModelIds: [],
    });

    expect(result.defaultSandboxType).toBe("vercel");
    expect(result.defaultDiffMode).toBe("unified");
  });

  test("drops invalid globalSkillRefs payloads", async () => {
    const { toUserPreferencesData } = await userPreferencesModulePromise;

    const result = toUserPreferencesData({
      defaultModelId: "openai/gpt-5",
      defaultSubagentModelId: null,
      defaultSandboxType: "vercel",
      defaultDiffMode: "split",
      autoCommitPush: false,
      autoCreatePr: false,
      alertsEnabled: true,
      alertSoundEnabled: true,
      publicUsageEnabled: false,
      globalSkillRefs: [{ source: "vercel/ai", skillName: "bad name" }] as never,
      defaultAgentName: "default",
      modelVariants: [],
      enabledModelIds: [],
    });

    expect(result.globalSkillRefs).toEqual([]);
  });

  test("keeps valid globalSkillRefs payloads", async () => {
    const { toUserPreferencesData } = await userPreferencesModulePromise;

    const result = toUserPreferencesData({
      defaultModelId: "openai/gpt-5",
      defaultSubagentModelId: null,
      defaultSandboxType: "vercel",
      defaultDiffMode: "split",
      autoCommitPush: false,
      autoCreatePr: false,
      alertsEnabled: true,
      alertSoundEnabled: true,
      publicUsageEnabled: false,
      globalSkillRefs: [
        { source: "vercel/ai", skillName: "ai-sdk" },
        { source: "vercel/ai", skillName: "ai-sdk" },
      ],
      defaultAgentName: "default",
      modelVariants: [],
      enabledModelIds: [],
    });

    expect(result.globalSkillRefs).toEqual([{ source: "vercel/ai", skillName: "ai-sdk" }]);
  });

  test("drops invalid modelVariants payloads", async () => {
    const { toUserPreferencesData } = await userPreferencesModulePromise;

    const result = toUserPreferencesData({
      defaultModelId: "openai/gpt-5",
      defaultSubagentModelId: null,
      defaultSandboxType: "vercel",
      defaultDiffMode: "split",
      autoCommitPush: false,
      autoCreatePr: false,
      alertsEnabled: true,
      alertSoundEnabled: true,
      publicUsageEnabled: false,
      globalSkillRefs: [],
      defaultAgentName: "default",
      modelVariants: [{ id: "bad-id" }] as never,
      enabledModelIds: [],
    });

    expect(result.modelVariants).toEqual([]);
  });

  test("keeps valid modelVariants payloads", async () => {
    const { toUserPreferencesData } = await userPreferencesModulePromise;

    const result = toUserPreferencesData({
      defaultModelId: "openai/gpt-5",
      defaultSubagentModelId: null,
      defaultSandboxType: "vercel",
      defaultDiffMode: "split",
      autoCommitPush: true,
      autoCreatePr: true,
      alertsEnabled: true,
      alertSoundEnabled: true,
      publicUsageEnabled: false,
      globalSkillRefs: [],
      defaultAgentName: "default",
      modelVariants: [
        {
          id: "variant:test",
          name: "Test Variant",
          baseModelId: "openai/gpt-5",
          providerOptions: { reasoningEffort: "low" },
        },
      ],
      enabledModelIds: [],
    });

    expect(result).toEqual({
      defaultModelId: "openai/gpt-5",
      defaultSubagentModelId: null,
      defaultSandboxType: "vercel",
      defaultDiffMode: "split",
      autoCommitPush: true,
      autoCreatePr: true,
      alertsEnabled: true,
      alertSoundEnabled: true,
      publicUsageEnabled: false,
      globalSkillRefs: [],
      defaultAgentName: "default",
      modelVariants: [
        {
          id: "variant:test",
          name: "Test Variant",
          baseModelId: "openai/gpt-5",
          providerOptions: { reasoningEffort: "low" },
        },
      ],
      enabledModelIds: [],
    });
  });

  test("keeps publicUsageEnabled when provided", async () => {
    const { toUserPreferencesData } = await userPreferencesModulePromise;

    const result = toUserPreferencesData({
      defaultModelId: "openai/gpt-5",
      defaultSubagentModelId: null,
      defaultSandboxType: "vercel",
      defaultDiffMode: "split",
      autoCommitPush: false,
      autoCreatePr: false,
      alertsEnabled: true,
      alertSoundEnabled: true,
      publicUsageEnabled: true,
      globalSkillRefs: [],
      defaultAgentName: "default",
      modelVariants: [],
      enabledModelIds: [],
    });

    expect(result.publicUsageEnabled).toBe(true);
  });
});
