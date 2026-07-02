import * as fs from "node:fs/promises";
import path from "node:path";
import { cancel, isCancel, select, text } from "@clack/prompts";
import { Command } from "commander";
import type { FumaDB } from "..";

export function createCli(options: {
  db: FumaDB<any>;

  /**
   * CLI command name, must be lowercase without whitespaces.
   */
  command: string;
  description?: string;

  /**
   * CLI Version
   */
  version: string;
}) {
  const db = options.db as FumaDB;

  async function selectVersion(defaultValue?: string) {
    const schemas = db.schemas;
    const selected = await select({
      message: "Select target schema version:",
      options: schemas.map((s, i) => {
        let hint: string | undefined;
        if (s.version === defaultValue) {
          hint = "current";
        } else if (i === schemas.length - 1) {
          hint = "latest";
        }

        return {
          value: s.version,
          label: s.version,
          hint,
        };
      }),
      initialValue: defaultValue,
    });

    if (isCancel(selected)) {
      cancel("Migration cancelled.");
      process.exit(0);
    }

    return selected;
  }

  async function inputOutputPath(type: "sql" | "orm", suggestion: string) {
    const result = await text({
      message:
        type === "sql"
          ? "Where to output the SQL migration file?"
          : "Where to output the generated schema? (it will override the destination)",
      defaultValue: suggestion,
      placeholder: suggestion,
    });

    if (isCancel(result)) {
      cancel("Migration cancelled.");
      process.exit(0);
    }

    return result;
  }

  return {
    async main() {
      const program = new Command();
      program
        .name(options.command)
        .description(
          options.description ??
            "FumaDB CLI for migrations and schema generation"
        )
        .version(options.version);

      program
        .command("migrate:up")
        .description("Migrate to the next schema version")
        .action(async () => {
          const migrator = db.createMigrator();
          const next = await migrator.next();
          if (!next) {
            console.log("Already up to date.");
            process.exit(1);
          }

          const result = await migrator.migrateTo(next.version);
          await result.execute();
          console.log(`Migration to ${next.version} executed.`);
        });

      program
        .command("migrate:down")
        .description("Rollback to the previous schema version")
        .action(async () => {
          const migrator = db.createMigrator();
          const prev = await migrator.previous();
          if (!prev) {
            console.log("Cannot downgrade.");
            process.exit(1);
          }

          const result = await migrator.migrateTo(prev.version);
          await result.execute();
          console.log(`Migration to ${prev.version} executed.`);
        });

      program
        .command("migrate:to [version]")
        .alias("migrate")
        .description(
          "Migrate to a specific schema version (interactive if not provided)"
        )
        .action(async (version: string | undefined) => {
          const migrator = db.createMigrator();
          version ??= await selectVersion(await migrator.getVersion());
          const result =
            version === "latest"
              ? await migrator.migrateToLatest()
              : await migrator.migrateTo(version);

          await result.execute();
          console.log(`Migrated to version ${version}.`);
        });

      program
        .command("generate [version]")
        .description(
          "Output SQL (for Kysely) or database schema (for ORMs) for the migration."
        )
        .option(
          "-o, --output <PATH>",
          "the output path of generated SQL/schema file"
        )
        .action(
          async (
            version: string | undefined,
            { output }: { output?: string }
          ) => {
            let generated: string;

            if (db.adapter.createMigrationEngine) {
              const migrator = db.createMigrator();
              version ??= await selectVersion(await migrator.getVersion());

              const result =
                version === "latest"
                  ? await migrator.migrateToLatest()
                  : await migrator.migrateTo(version);

              if (!result.getSQL)
                throw new Error(
                  "The adapter doesn't support migration file generation."
                );

              generated = result.getSQL();
              output ??= await inputOutputPath(
                "sql",
                `./migrations/${Date.now()}.sql`
              );
            } else if (db.adapter.generateSchema) {
              version ??= await selectVersion();
              const result = db.generateSchema(version);

              generated = result.code;
              output ??= await inputOutputPath("orm", result.path);
            } else {
              throw new Error(
                "The adapter doesn't support migration generation."
              );
            }

            await fs.mkdir(path.dirname(output), { recursive: true });
            await fs.writeFile(output, generated);
            console.log("Successful.");
          }
        );

      await program.parseAsync(process.argv);
    },
  };
}
