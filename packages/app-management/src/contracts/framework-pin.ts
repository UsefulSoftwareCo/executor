import { Schema } from "effect";

export const frameworkPinRelease = "0.0.1-beta.2";

export const frameworkPinCatchUpRelease = "0.0.1-beta.5";

export const FrameworkPinOutcome = Schema.Literals([
  "pin",
  "pin-behind",
  "pin-unpublished",
  "pin-diverged",
  "pin-undeployed",
  "pinned",
  "pinned-behind",
  "pinned-unpublished",
  "pinned-diverged",
  "pinned-undeployed",
  "declared",
  "invalid-manifest",
  "conflict",
  "failed",
  "removed",
]);
export type FrameworkPinOutcome = typeof FrameworkPinOutcome.Type;

export const frameworkPinMessage = (apps: string) =>
  `Pin the apps framework to ${apps}\n\nExecutor declared the framework release this app was built with, so host upgrades do not change it.`;

export const frameworkPinBehindMessage = (apps: string) =>
  `Pin the apps framework to ${apps}\n\nExecutor saved the source of the running version, which this branch did not have yet, and declared the framework release it was built with, so host upgrades do not change it.`;
