import { Context, Effect, Layer } from "effect";

import { DYNAMIC_UI_MCP_APPS_FEATURE_FLAG } from "@executor-js/plugin-dynamic-ui";

export type FeatureFlagContext = Record<string, never>;

export type FeatureFlagsShape = {
  readonly isEnabled: (flag: string, context: FeatureFlagContext) => Effect.Effect<boolean, never>;
};

export class LocalFeatureFlags extends Context.Service<LocalFeatureFlags, FeatureFlagsShape>()(
  "@executor-js/local/FeatureFlags",
) {}

const truthy = (value: string | undefined): boolean =>
  value === "1" || value === "true" || value === "TRUE" || value === "yes" || value === "on";

const envNameForFlag = (flag: string): string =>
  `EXECUTOR_FEATURE_${flag
    .replaceAll(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()}`;

const readFlag = (flag: string, env: NodeJS.ProcessEnv): boolean => {
  const generic = env[envNameForFlag(flag)];
  return generic !== undefined ? truthy(generic) : false;
};

export const makeLocalEnvFeatureFlags = (
  env: NodeJS.ProcessEnv = process.env,
): FeatureFlagsShape => ({
  isEnabled: (flag) => Effect.sync(() => readFlag(flag, env)),
});

export const isGeneratedUiMcpAppsEnabled = (featureFlags: FeatureFlagsShape) =>
  featureFlags.isEnabled(DYNAMIC_UI_MCP_APPS_FEATURE_FLAG, {});

export const LocalEnvFeatureFlags = Layer.succeed(LocalFeatureFlags, makeLocalEnvFeatureFlags());
