/* oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- test fake models missing R2 objects */

import { writeFileSync, readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  googleOpenApiR2BlobMigration,
  type R2ObjectStore,
} from "../../scripts/code-migrations/google-openapi-r2-blobs";
import type { CodeMigrationContext, CodeMigrationSql } from "../../scripts/code-migrations/runner";

interface GoogleRow {
  readonly tenant: string;
  readonly slug: string;
  readonly plugin_id: string;
  readonly spec_hash: string;
}

const sourceKey = (row: GoogleRow): string => `o:${row.tenant}/openapi/spec/${row.spec_hash}`;
const targetKey = (row: GoogleRow): string => `o:${row.tenant}/google/spec/${row.spec_hash}`;

const makeSql = (rows: readonly GoogleRow[]): CodeMigrationSql => ({
  unsafe: () => Promise.resolve(rows as never),
});

const makeStore = (
  objects: Record<string, string>,
): { readonly store: R2ObjectStore; readonly objects: Map<string, Buffer> } => {
  const objectMap = new Map<string, Buffer>(
    Object.entries(objects).map(([key, value]) => [key, Buffer.from(value, "utf8")] as const),
  );
  return {
    objects: objectMap,
    store: {
      exists: (key) => objectMap.has(key),
      get: (key, file) => {
        const value = objectMap.get(key);
        if (!value) throw new Error(`missing ${key}`);
        writeFileSync(file, value);
      },
      put: (key, file) => {
        objectMap.set(key, readFileSync(file));
      },
    },
  };
};

const runMigration = async (input: {
  readonly dryRun: boolean;
  readonly rows: readonly GoogleRow[];
  readonly objects: Record<string, string>;
}) => {
  const { store, objects } = makeStore(input.objects);
  const migration = googleOpenApiR2BlobMigration({ bucket: "executor-cloud-blobs", store });
  const context: CodeMigrationContext = {
    sql: makeSql(input.rows),
    dryRun: input.dryRun,
    log: () => {},
  };
  return { result: await migration.run(context), objects };
};

describe("googleOpenApiR2BlobMigration", () => {
  it.effect("dry run reports source and target R2 coverage without copying", () =>
    Effect.promise(async () => {
      const rows = [
        { tenant: "org_1", slug: "google", plugin_id: "openapi", spec_hash: "hash-a" },
        { tenant: "org_2", slug: "google", plugin_id: "openapi", spec_hash: "hash-b" },
      ];
      const { result, objects } = await runMigration({
        dryRun: true,
        rows,
        objects: {
          [sourceKey(rows[0]!)]: "spec-a",
          [targetKey(rows[0]!)]: "spec-a",
          [sourceKey(rows[1]!)]: "spec-b",
        },
      });

      expect(result.summary).toContain("2/2 source R2 object(s) present");
      expect(result.summary).toContain("1/2 target R2 object(s) already present");
      expect(result.summary).toContain("would copy 1 object(s)");
      expect(objects.has(targetKey(rows[1]!))).toBe(false);
    }),
  );

  it.effect("apply copies missing target objects and leaves existing matches alone", () =>
    Effect.promise(async () => {
      const rows = [
        { tenant: "org_1", slug: "google", plugin_id: "google", spec_hash: "hash-a" },
        { tenant: "org_2", slug: "google", plugin_id: "google", spec_hash: "hash-b" },
      ];
      const { result, objects } = await runMigration({
        dryRun: false,
        rows,
        objects: {
          [sourceKey(rows[0]!)]: "spec-a",
          [targetKey(rows[0]!)]: "spec-a",
          [sourceKey(rows[1]!)]: "spec-b",
        },
      });

      expect(result.summary).toContain("copied 1 R2 object(s)");
      expect(objects.get(targetKey(rows[1]!))?.toString("utf8")).toBe("spec-b");
    }),
  );

  it.effect("fails when a source object is missing", () =>
    Effect.promise(async () => {
      const rows = [{ tenant: "org_1", slug: "google", plugin_id: "openapi", spec_hash: "hash-a" }];

      await expect(runMigration({ dryRun: true, rows, objects: {} })).rejects.toThrow(
        "source object(s) missing",
      );
    }),
  );
});
