import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import type { SqliteDataMigrationClient } from "@executor-js/sdk/core";

import {
  runSqliteOpenApiOutputSchemaMigration,
  unwrapOpenApiTransportEnvelope,
} from "./output-schema-migration";

// The exact shape openApiTransportOutputSchema used to emit.
const envelope = (dataSchema: unknown) => ({
  type: "object",
  additionalProperties: false,
  required: ["status", "headers", "data"],
  properties: {
    status: { type: "integer" },
    headers: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    data: dataSchema,
  },
});

describe("unwrapOpenApiTransportEnvelope", () => {
  it("unwraps the envelope to its data schema", () => {
    const payload = { type: "object", properties: { name: { type: "string" } } };
    expect(unwrapOpenApiTransportEnvelope(envelope(payload))).toEqual({ outputSchema: payload });
  });

  it("maps the empty data schema to null (new producer persists no schema)", () => {
    expect(unwrapOpenApiTransportEnvelope(envelope({}))).toEqual({ outputSchema: null });
  });

  it("leaves payload-shaped schemas untouched", () => {
    expect(unwrapOpenApiTransportEnvelope({ $ref: "#/$defs/single_response" })).toBeUndefined();
    expect(
      unwrapOpenApiTransportEnvelope({
        // A user API that happens to return {status, headers, data} but isn't
        // the envelope (different property schemas, no additionalProperties).
        type: "object",
        required: ["status", "headers", "data"],
        properties: { status: { type: "string" }, headers: {}, data: {} },
      }),
    ).toBeUndefined();
    expect(unwrapOpenApiTransportEnvelope(null)).toBeUndefined();
    expect(unwrapOpenApiTransportEnvelope("[]")).toBeUndefined();
  });
});

// A tiny scripted fake standing in for a libSQL client.
const makeFakeClient = (rows: Record<string, unknown>[], options?: { noTable?: boolean }) => {
  const log: unknown[] = [];
  const client: SqliteDataMigrationClient = {
    execute: (stmt) => {
      log.push(stmt);
      if (typeof stmt === "string" && stmt.includes("sqlite_master")) {
        return Promise.resolve({ rows: options?.noTable ? [] : [{ name: "tool" }] });
      }
      if (typeof stmt === "string" && stmt.startsWith("SELECT row_id")) {
        return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { client, log };
};

describe("runSqliteOpenApiOutputSchemaMigration", () => {
  it.effect("rewrites envelope rows in a transaction and reports the count", () =>
    Effect.gen(function* () {
      const payload = { type: "array", items: { type: "object" } };
      const { client, log } = makeFakeClient([
        { row_id: "a", output_schema: JSON.stringify(envelope(payload)) },
        { row_id: "b", output_schema: JSON.stringify(envelope({})) },
        { row_id: "c", output_schema: JSON.stringify({ $ref: "#/$defs/already_payload" }) },
        { row_id: "d", output_schema: "not json" },
      ]);
      const count = yield* runSqliteOpenApiOutputSchemaMigration(client);
      expect(count).toBe(2);
      expect(log).toContainEqual("BEGIN");
      expect(log).toContainEqual({
        sql: "UPDATE tool SET output_schema = ? WHERE row_id = ?",
        args: [JSON.stringify(payload), "a"],
      });
      expect(log).toContainEqual({
        sql: "UPDATE tool SET output_schema = ? WHERE row_id = ?",
        args: [null, "b"],
      });
      expect(log).toContainEqual("COMMIT");
    }),
  );

  it.effect("no-ops when every row is already payload-shaped", () =>
    Effect.gen(function* () {
      const { client, log } = makeFakeClient([
        { row_id: "a", output_schema: JSON.stringify({ $ref: "#/$defs/already_payload" }) },
      ]);
      const count = yield* runSqliteOpenApiOutputSchemaMigration(client);
      expect(count).toBe(0);
      expect(log).not.toContainEqual("BEGIN");
    }),
  );

  it.effect("treats a missing tool table as nothing to migrate", () =>
    Effect.gen(function* () {
      const { client } = makeFakeClient([], { noTable: true });
      const count = yield* runSqliteOpenApiOutputSchemaMigration(client);
      expect(count).toBe(0);
    }),
  );

  it.effect("rolls back and surfaces the failure when an update fails", () =>
    Effect.gen(function* () {
      const log: unknown[] = [];
      const client: SqliteDataMigrationClient = {
        execute: (stmt) => {
          log.push(stmt);
          if (typeof stmt === "string" && stmt.includes("sqlite_master")) {
            return Promise.resolve({ rows: [{ name: "tool" }] });
          }
          if (typeof stmt === "string" && stmt.startsWith("SELECT row_id")) {
            return Promise.resolve({
              rows: [{ row_id: "a", output_schema: JSON.stringify(envelope({})) }],
            });
          }
          if (typeof stmt === "object" && stmt.sql.startsWith("UPDATE tool")) {
            // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- simulates a raw driver failure at the adapter boundary under test
            return Promise.reject(new Error("disk full"));
          }
          return Promise.resolve({ rows: [] });
        },
      };
      const failure = yield* runSqliteOpenApiOutputSchemaMigration(client).pipe(Effect.flip);
      expect(Predicate.isTagged(failure, "DataMigrationError")).toBe(true);
      expect(log).toContainEqual("ROLLBACK");
      expect(log).not.toContainEqual("COMMIT");
    }),
  );
});
