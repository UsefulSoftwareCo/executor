import { describe, expect, it } from "@effect/vitest";

import {
  runSqliteOpenApiOutputSchemaMigration,
  unwrapOpenApiTransportEnvelope,
  type SqliteToolSchemaClient,
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
  const client: SqliteToolSchemaClient = {
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
  it("rewrites envelope rows in a transaction and reports the count", async () => {
    const payload = { type: "array", items: { type: "object" } };
    const { client, log } = makeFakeClient([
      { row_id: "a", output_schema: JSON.stringify(envelope(payload)) },
      { row_id: "b", output_schema: JSON.stringify(envelope({})) },
      { row_id: "c", output_schema: JSON.stringify({ $ref: "#/$defs/already_payload" }) },
      { row_id: "d", output_schema: "not json" },
    ]);
    const count = await runSqliteOpenApiOutputSchemaMigration(client);
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
  });

  it("no-ops when every row is already payload-shaped", async () => {
    const { client, log } = makeFakeClient([
      { row_id: "a", output_schema: JSON.stringify({ $ref: "#/$defs/already_payload" }) },
    ]);
    expect(await runSqliteOpenApiOutputSchemaMigration(client)).toBe(0);
    expect(log).not.toContainEqual("BEGIN");
  });

  it("treats a missing tool table as nothing to migrate", async () => {
    const { client } = makeFakeClient([], { noTable: true });
    expect(await runSqliteOpenApiOutputSchemaMigration(client)).toBe(0);
  });
});
