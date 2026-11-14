/**
 * The `database-connections` signature: how long a deployed stage waited for database
 * connections (read by `e2e/sdk/database-connections.ts`). Cloud tests on main counts each
 * stage's level in its coverage summary (`e2e/ci-selection.ts`, `verify deployed`) beside the
 * platform signatures; it informs and never fails a run.
 */
import { Schema } from "effect";

/** `elevated` and `severe` thresholds, in milliseconds: the run's average and its worst minute. */
export const connectionLatencyLevels = {
  elevated: { averageMs: 10, worstMinuteMs: 100 },
  severe: { averageMs: 50, worstMinuteMs: 300 },
} as const;

export const DatabaseConnections = Schema.Struct({
  source: Schema.Literals(["hyperdrive", "spans", "unavailable"]),
  level: Schema.Literals(["normal", "elevated", "severe", "unknown"]),
  averageMs: Schema.optionalKey(Schema.Number),
  worstMinuteMs: Schema.optionalKey(Schema.Number),
  minutes: Schema.optionalKey(Schema.Number),
  queries: Schema.optionalKey(Schema.Number),
  /** Why the Hyperdrive figure, or any figure, could not be read. Fixed text only. */
  note: Schema.optionalKey(Schema.String),
});
export type DatabaseConnections = typeof DatabaseConnections.Type;

/** The file each deployed run writes beside its environment record. */
export const databaseConnectionsFile = "database-connections.json";

export const connectionLevel = (averageMs: number, worstMinuteMs: number) =>
  averageMs >= connectionLatencyLevels.severe.averageMs ||
  worstMinuteMs >= connectionLatencyLevels.severe.worstMinuteMs
    ? "severe"
    : averageMs >= connectionLatencyLevels.elevated.averageMs ||
        worstMinuteMs >= connectionLatencyLevels.elevated.worstMinuteMs
      ? "elevated"
      : "normal";
