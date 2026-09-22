/** Temporary previews own isolated database branches and a fixed, nonrenewable lifetime. */
import { Schema } from "effect";
import { TestStageSlug } from "../infrastructure/stage.ts";

/** Hyperdrive's minimum pool size, isolated to each preview's database branch. */
export const testStageConnectionLimit = 5;
/** No deployment or keep command can extend a preview beyond three hours. */
export const testStageLifetimeMilliseconds = 3 * 60 * 60 * 1000;
/** Start cleanup early enough to leave time for scheduled-run delays and retries. */
export const testStageCleanupLeadMilliseconds = 15 * 60 * 1000;
/** A deploy is bounded and must finish before the cleanup window opens. */
export const testStageDeployMilliseconds = 30 * 60 * 1000;

/** Public lease data contains no credentials or customer data. */
export const TestStageLease = Schema.Struct({
  slug: TestStageSlug,
  owner: Schema.NonEmptyString,
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
});
/** Persisted control metadata, written before cloud resources are created. */
export type TestStageLease = typeof TestStageLease.Type;
/** The time when a preview must begin disposal. */
export const testStageCleanupAt = (lease: TestStageLease) =>
  lease.expiresAt - testStageCleanupLeadMilliseconds;
/** A redeploy must leave the full cleanup window. */
export const canDeployTestStage = (lease: TestStageLease, now: number) =>
  now + testStageDeployMilliseconds <= testStageCleanupAt(lease);
/** Administration failures expose a safe explanation, never credentials. */
export class TestStageFailed extends Schema.TaggedError<TestStageFailed>()("TestStageFailed", {
  message: Schema.String,
}) {}
