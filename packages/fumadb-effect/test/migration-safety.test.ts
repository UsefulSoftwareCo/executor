/**
 * The migration engine's destructive-operation gate.
 *
 * A migration that runs unattended at startup must never drop a table or a
 * column. These cases drive `createMigrator` with a fake settings store, so
 * the plan is checked without a database.
 */
import { Effect, Option } from "effect";
import type { Provider } from "../src/contracts/provider.ts";
import { providers } from "../src/contracts/provider.ts";
import { describe, expect, it } from "vitest";
import { createMigrator } from "../src/implementation/migration/migrator.ts";
import type { MigrationOperation } from "../src/contracts/migration-operation.ts";
import type { MigrateOptions, MigrationEngineOptions } from "../src/contracts/migration.ts";
import { migrateV3, migrateV4 } from "./support/schemas.ts";

/**
 * A migrator over the 3.0.0 -> 4.0.0 step, which removes the `email` column
 * and the whole `accounts` table.
 */
const planStep = (
  options?: MigrateOptions,
  userConfig: MigrationEngineOptions<never>["userConfig"] = { provider: "postgresql" },
): ReadonlyArray<MigrationOperation> => {
  const migrator = createMigrator<never>({
    libConfig: { namespace: "test", schemas: [migrateV3, migrateV4] },
    userConfig,
    executor: () => Effect.void,
    settings: {
      getVersion: Effect.succeed(Option.some("3.0.0")),
      getNameVariants: Effect.succeed(Option.none()),
      updateSettingsInMigration: () => Effect.succeed([]),
    },
  });
  return Effect.runSync(migrator.up(options)).operations;
};

const kinds = (operations: ReadonlyArray<MigrationOperation>): ReadonlyArray<string> =>
  operations.flatMap((op) =>
    op.type === "update-table" ? op.value.map((action) => action.type) : [op.type],
  );

/** The columns an `update-column` operation makes nullable. */
const madeNullable = (operations: ReadonlyArray<MigrationOperation>): ReadonlyArray<string> =>
  operations.flatMap((op) =>
    op.type === "update-table"
      ? op.value.flatMap((action) =>
          action.type === "update-column" && action.updateNullable && action.value.isNullable
            ? [action.name]
            : [],
        )
      : [],
  );

describe.each(providers)("migrateTo in from-schema mode on %s", (provider: Provider) => {
  const config = { provider } as const;

  it("drops nothing without `unsafe`", () => {
    const planned = kinds(planStep(undefined, config));
    expect(planned).not.toContain("drop-table");
    expect(planned).not.toContain("drop-column");
  });

  it("makes a required column without a default nullable instead of dropping it", () => {
    // `email` is required and has no default; keeping it NOT NULL would make
    // every insert fail, so it is altered to accept NULL.
    expect(madeNullable(planStep(undefined, config))).toEqual(["email"]);
  });

  it("drops the unused table and columns with `unsafe`", () => {
    const planned = planStep({ unsafe: true }, config);
    expect(kinds(planned)).toContain("drop-table");
    expect(kinds(planned)).toContain("drop-column");
    expect(madeNullable(planned)).toEqual([]);
  });

  it("defaults to safe when no options are passed at all", () => {
    const planned = kinds(planStep({ mode: "from-schema" }, config));
    expect(planned).not.toContain("drop-table");
    expect(planned).not.toContain("drop-column");
  });

  // `unsafe` is only the default. An adapter that states a drop setting keeps
  // it, in either direction.
  it("keeps an adapter's explicit `false` under `unsafe`", () => {
    const planned = kinds(
      planStep({ unsafe: true }, { provider, dropUnusedTables: false, dropUnusedColumns: false }),
    );
    expect(planned).not.toContain("drop-table");
    expect(planned).not.toContain("drop-column");
  });

  it("keeps an adapter's explicit `true` without `unsafe`", () => {
    const planned = kinds(
      planStep(undefined, {
        provider,
        dropUnusedTables: true,
        dropUnusedColumns: true,
      }),
    );
    expect(planned).toContain("drop-table");
    expect(planned).toContain("drop-column");
  });
});
