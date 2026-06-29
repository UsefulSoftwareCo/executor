import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { isGeneratedUiMcpAppsEnabled, makeLocalEnvFeatureFlags } from "./feature-flags";

describe("local feature flags", () => {
  it.effect("keeps generated UI MCP apps disabled by default", () =>
    Effect.gen(function* () {
      const enabled = yield* isGeneratedUiMcpAppsEnabled(makeLocalEnvFeatureFlags({}));

      expect(enabled).toBe(false);
    }),
  );

  it.effect("enables generated UI MCP apps from the canonical env flag", () =>
    Effect.gen(function* () {
      const enabled = yield* isGeneratedUiMcpAppsEnabled(
        makeLocalEnvFeatureFlags({ EXECUTOR_FEATURE_GENERATED_UI_MCP_APPS: "true" }),
      );

      expect(enabled).toBe(true);
    }),
  );

  it.effect("ignores unrelated env variables", () =>
    Effect.gen(function* () {
      const enabled = yield* isGeneratedUiMcpAppsEnabled(
        makeLocalEnvFeatureFlags({ EXECUTOR_DYNAMIC_UI: "1" }),
      );

      expect(enabled).toBe(false);
    }),
  );
});
