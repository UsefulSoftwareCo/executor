import { Schema } from "effect";
import { previewHomeRepository, previewOwner } from "./pr-preview-selection.ts";

export const TestStageSlug = Schema.String.check(
  Schema.makeFilter((value) => /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/.test(value), {
    message: "A test stage slug is 1-42 lowercase letters, digits and hyphens",
  }),
);

export const testStageLifetimeMilliseconds = 3 * 60 * 60 * 1000;
export const testStageCleanupLeadMilliseconds = 15 * 60 * 1000;
export const testStageDeployMilliseconds = 30 * 60 * 1000;

const identity = {
  slug: TestStageSlug,
  owner: Schema.NonEmptyString,
  createdAt: Schema.Number,
  database: Schema.Literals(["neon", "planetscale"]),
};
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
export type TestStageLease = typeof TestStageLease.Type;
export const testStageCleanupAt = (lease: TestStageLease) =>
  lease.expiresAt === null ? null : lease.expiresAt - testStageCleanupLeadMilliseconds;
export const isTestStageDue = (lease: TestStageLease, now: number) => {
  const deadline = testStageCleanupAt(lease);
  return deadline !== null && now >= deadline;
};
export const canDeployTestStage = (lease: TestStageLease, now: number) => {
  const deadline = testStageCleanupAt(lease);
  return deadline === null || now + testStageDeployMilliseconds <= deadline;
};
export const testStageLimit = 80;
export const isEvictableTestStage = (lease: TestStageLease) => {
  if (lease.retention === "temporary") return true;
  const number = Number(/^pr-([1-9][0-9]*)$/u.exec(lease.slug)?.[1]);
  return (
    Number.isSafeInteger(number) &&
    lease.database === "neon" &&
    lease.owner === previewOwner(previewHomeRepository, number)
  );
};
export const stagesToEvict = (leases: readonly TestStageLease[], slug: string) => {
  const others = leases.filter((lease) => lease.slug !== slug);
  const needed = Math.max(0, others.length - testStageLimit + 1);
  return {
    needed,
    evictions: others
      .filter(isEvictableTestStage)
      .toSorted((a, b) => a.createdAt - b.createdAt)
      .slice(0, needed),
  };
};
export class TestStageFailed extends Schema.TaggedError<TestStageFailed>()("TestStageFailed", {
  message: Schema.String,
}) {}
