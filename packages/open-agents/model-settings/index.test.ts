import { describe, expect, mock, test } from "bun:test";
import type { ProviderOptionsByProvider } from "./index";

mock.module("ai", () => {
  return {
    tool: <T extends Record<string, unknown>>(definition: T) => definition,
    isStepCount: (count: number) => ({ count }),
    getToolName: (part: { toolName?: string; type?: string }) => {
      if (part.toolName) {
        return part.toolName;
      }

      if (typeof part.type === "string" && part.type.startsWith("tool-")) {
        return part.type.slice(5);
      }

      return "";
    },
    isToolUIPart: (part: unknown) => {
      if (!part || typeof part !== "object") {
        return false;
      }

      const candidate = part as { type?: unknown };
      return typeof candidate.type === "string" && candidate.type.startsWith("tool-");
    },
  };
});

mock.module("@ai-sdk/devtools", () => ({
  devToolsMiddleware: () => ({ kind: "devtools-middleware" }),
}));

const {
  getProviderOptionsForModel,
  languageModelSettings,
  mergeProviderOptions,
  shouldApplyOpenAIReasoningDefaults,
} = await import("./index");

describe("shouldApplyOpenAIReasoningDefaults", () => {
  test("returns true for existing GPT-5 variants", () => {
    expect(shouldApplyOpenAIReasoningDefaults("openai/gpt-5.3")).toBe(true);
    expect(shouldApplyOpenAIReasoningDefaults("openai/gpt-5.4")).toBe(true);
  });

  test("returns true for future GPT-5 variants", () => {
    expect(shouldApplyOpenAIReasoningDefaults("openai/gpt-5.9")).toBe(true);
  });

  test("returns false for non-GPT-5 OpenAI models", () => {
    expect(shouldApplyOpenAIReasoningDefaults("openai/gpt-4o")).toBe(false);
  });
});

describe("getProviderOptionsForModel", () => {
  test("applies adaptive thinking defaults to Anthropic 4.6 models", () => {
    const result = getProviderOptionsForModel("anthropic/claude-sonnet-4.6");

    expect(result).toEqual({
      anthropic: {
        effort: "medium",
        thinking: { type: "adaptive" },
      },
    });
  });

  test("applies adaptive thinking defaults to Anthropic 4.7 models", () => {
    const result = getProviderOptionsForModel("anthropic/claude-opus-4.7");

    expect(result).toEqual({
      anthropic: {
        effort: "medium",
        thinking: { type: "adaptive" },
      },
    });
  });

  test("applies budgeted thinking defaults to Anthropic 4.5 models", () => {
    const result = getProviderOptionsForModel("anthropic/claude-opus-4.5");

    expect(result).toEqual({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 8000,
        },
      },
    });
  });

  test("merges OpenAI defaults with custom variant options", () => {
    const result = getProviderOptionsForModel("openai/gpt-5", {
      openai: {
        reasoningEffort: "medium",
      },
    });

    expect(result).toEqual({
      openai: {
        reasoningSummary: "detailed",
        include: ["reasoning.encrypted_content"],
        reasoningEffort: "medium",
        store: false,
      },
    });
  });

  test("applies low text verbosity defaults to GPT-5.4 snapshots", () => {
    const result = getProviderOptionsForModel("openai/gpt-5.4-2026-03-05");

    expect(result).toEqual({
      openai: {
        reasoningSummary: "detailed",
        include: ["reasoning.encrypted_content"],
        store: false,
        textVerbosity: "low",
      },
    });
  });

  test("preserves store false and encrypted reasoning content for the built-in GPT-5.4 variant", () => {
    const result = getProviderOptionsForModel("openai/gpt-5.4", {
      openai: {
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
      },
    });

    expect(result).toEqual({
      openai: {
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
        store: false,
        textVerbosity: "low",
      },
    });
  });

  test("enforces store false for OpenAI models even when variant overrides it", () => {
    const result = getProviderOptionsForModel("openai/gpt-5", {
      openai: {
        store: true,
      },
    });

    expect(result).toEqual({
      openai: {
        reasoningSummary: "detailed",
        include: ["reasoning.encrypted_content"],
        store: false,
      },
    });
  });

  test("applies store false to non-GPT-5 OpenAI models", () => {
    const result = getProviderOptionsForModel("openai/gpt-4o");

    expect(result).toEqual({
      openai: {
        store: false,
      },
    });
  });
});

describe("mergeProviderOptions", () => {
  test("returns defaults when overrides are undefined", () => {
    const defaults: ProviderOptionsByProvider = {
      openai: {
        reasoningEffort: "high",
      },
    };

    expect(mergeProviderOptions(defaults)).toEqual(defaults);
  });

  test("deep merges nested provider options", () => {
    const defaults: ProviderOptionsByProvider = {
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 8000,
        },
      },
    };

    const overrides: ProviderOptionsByProvider = {
      anthropic: {
        thinking: {
          budgetTokens: 4000,
        },
      },
    };

    expect(mergeProviderOptions(defaults, overrides)).toEqual({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 4000,
        },
      },
    });
  });

  test("adds provider overrides that do not exist in defaults", () => {
    const defaults: ProviderOptionsByProvider = {
      openai: {
        store: false,
      },
    };

    const overrides: ProviderOptionsByProvider = {
      anthropic: {
        effort: "low",
      },
    };

    expect(mergeProviderOptions(defaults, overrides)).toEqual({
      openai: {
        store: false,
      },
      anthropic: {
        effort: "low",
      },
    });
  });

  test("replaces arrays instead of deep-merging arrays", () => {
    const defaults: ProviderOptionsByProvider = {
      openai: {
        include: ["reasoning.encrypted_content"],
      },
    };

    const overrides: ProviderOptionsByProvider = {
      openai: {
        include: ["reasoning.summary"],
      },
    };

    expect(mergeProviderOptions(defaults, overrides)).toEqual({
      openai: {
        include: ["reasoning.summary"],
      },
    });
  });
});

describe("languageModelSettings", () => {
  test("keeps Anthropic model ids on AI Gateway", () => {
    const settings = languageModelSettings(
      "anthropic/claude-sonnet-4.6" as never,
    );

    expect(settings.model).toBe("anthropic/claude-sonnet-4.6");
    expect(settings.providerOptions).toEqual({
      anthropic: {
        effort: "medium",
        thinking: { type: "adaptive" },
      },
    });
  });

  test("keeps OpenAI model ids on AI Gateway", () => {
    const settings = languageModelSettings("openai/gpt-5.4" as never);

    expect(settings.model).toBe("openai/gpt-5.4");
    expect(settings.providerOptions).toEqual({
      openai: {
        reasoningSummary: "detailed",
        include: ["reasoning.encrypted_content"],
        store: false,
        textVerbosity: "low",
      },
    });
  });
});
