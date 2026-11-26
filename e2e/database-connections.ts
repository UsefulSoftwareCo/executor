import { Schema } from "effect";

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
  note: Schema.optionalKey(Schema.String),
});
export type DatabaseConnections = typeof DatabaseConnections.Type;

export const databaseConnectionsFile = "database-connections.json";

export const connectionLevel = (averageMs: number, worstMinuteMs: number) =>
  averageMs >= connectionLatencyLevels.severe.averageMs ||
  worstMinuteMs >= connectionLatencyLevels.severe.worstMinuteMs
    ? "severe"
    : averageMs >= connectionLatencyLevels.elevated.averageMs ||
        worstMinuteMs >= connectionLatencyLevels.elevated.worstMinuteMs
      ? "elevated"
      : "normal";
