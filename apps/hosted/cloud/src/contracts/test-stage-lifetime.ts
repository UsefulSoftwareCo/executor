/** Preview policy is persisted before provisioning; CI leases are bounded and development may be retained. */
import { Schema } from "effect";
import { TestStageSlug } from "../infrastructure/stage.ts";

/**
 * Hyperdrive's minimum pool size, isolated to each preview's database branch. A preview branch
 * allows 22 non-superuser connections, and Hyperdrive's limit is soft: after a redeploy with a
 * limit of 12, the branch refused new logins. Keep previews at the minimum.
 */
export const testStageConnectionLimit = 5;
/** Disposable CI environments have a fixed deadline, including failed deployment attempts. */
export const testStageLifetimeMilliseconds = 3 * 60 * 60 * 1000;
/** Start cleanup early enough to leave time for scheduled-run delays and retries. */
export const testStageCleanupLeadMilliseconds = 15 * 60 * 1000;
/** A deploy is bounded and must finish before the cleanup window opens. */
export const testStageDeployMilliseconds = 30 * 60 * 1000;

/** Public lease data contains no credentials or customer data. */
const identity = {
  slug: TestStageSlug,
  owner: Schema.NonEmptyString,
  createdAt: Schema.Number,
  database: Schema.Literals(["neon", "planetscale"]),
};
/** A retained environment can pause background work; temporary test runs always run it. */
export const TestStageLease = Schema.Union([
  Schema.Struct({
    ...identity,
    retention: Schema.Literal("temporary"),
    background: Schema.Literal("active"),
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    ...identity,
    retention: Schema.Literal("retained"),
    background: Schema.Literals(["active", "paused"]),
    expiresAt: Schema.Null,
  }),
]);
/** Persisted control metadata, written before cloud resources are created. */
export type TestStageLease = typeof TestStageLease.Type;
/** The time when a preview must begin disposal. */
export const testStageCleanupAt = (lease: TestStageLease) =>
  lease.expiresAt === null ? null : lease.expiresAt - testStageCleanupLeadMilliseconds;
/** Retained stages are never selected by scheduled expiry cleanup. */
export const isTestStageDue = (lease: TestStageLease, now: number) => {
  const deadline = testStageCleanupAt(lease);
  return deadline !== null && now >= deadline;
};
/** A redeploy must leave the full cleanup window. */
export const canDeployTestStage = (lease: TestStageLease, now: number) => {
  const deadline = testStageCleanupAt(lease);
  return deadline === null || now + testStageDeployMilliseconds <= deadline;
};
/** Administration failures expose a safe explanation, never credentials. */
export class TestStageFailed extends Schema.TaggedError<TestStageFailed>()("TestStageFailed", {
  message: Schema.String,
}) {}
