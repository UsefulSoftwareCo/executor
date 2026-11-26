import { Schema } from "effect";

export const executorAppRedeployStepName = "5_redeploy_pre_beta10_executor_apps";

export const executorAppRedeployFixedRelease = "0.0.1-beta.10";

export const executorAppRedeployTargetRelease = "0.0.1-beta.84";

export const ExecutorAppRedeployOutcome = Schema.Literals([
  "redeploy",
  "redeploy-behind",
  "redeploy-pinned",
  "redeploy-behind-pinned",
  "redeployed",
  "redeployed-behind",
  "redeployed-pinned",
  "redeployed-behind-pinned",
  "current",
  "other-pin",
  "edited",
  "undeployed",
  "build-failed",
  "conflict",
  "failed",
  "removed",
]);
export type ExecutorAppRedeployOutcome = typeof ExecutorAppRedeployOutcome.Type;

export const executorAppRedeployMessage = (from: string, to: string) =>
  `Update the apps framework from ${from} to ${to}\n\nExecutor redeployed this app on a framework release that refreshes cached values in the background. No other file changed.`;
