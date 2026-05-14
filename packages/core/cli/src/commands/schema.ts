import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { collectTables } from "@executor-js/sdk/core";
import { getConfig } from "../utils/get-config.js";

type SchemaGenerateOptions = {
  readonly cwd: string;
  readonly config?: string;
  readonly output?: string;
  readonly namespace: string;
  readonly adapter: string;
  readonly provider: string;
  readonly version: string;
};

const schemaGenerateAction = async (opts: SchemaGenerateOptions) => {
  const cwd = path.resolve(opts.cwd);
  if (!existsSync(cwd)) {
    console.error(`The directory "${cwd}" does not exist.`);
    process.exit(1);
  }

  const config = await getConfig({ cwd, configPath: opts.config });
  if (!config) {
    console.error(
      "No configuration file found. Add an `executor.config.ts` file to " +
        "your project or pass the path using the `--config` flag.",
    );
    process.exit(1);
  }
  if (opts.adapter !== "drizzle") {
    console.error(`Unsupported schema adapter "${opts.adapter}". Supported adapters: drizzle.`);
    process.exit(1);
  }
  if (opts.provider !== "mysql" && opts.provider !== "postgresql" && opts.provider !== "sqlite") {
    console.error(
      `Unsupported drizzle provider "${opts.provider}". Supported providers: mysql, postgresql, sqlite.`,
    );
    process.exit(1);
  }

  const [{ fumadb }, { drizzleAdapter }, { schema: fumaSchema }] = await Promise.all([
    import("fumadb"),
    import("fumadb/adapters/drizzle"),
    import("fumadb/schema"),
  ]);

  const schema = fumaSchema({
    version: opts.version,
    tables: collectTables(config.plugins()),
  });
  const factory = fumadb({
    namespace: opts.namespace,
    schemas: [schema],
  });
  const generated = factory
    .client(
      drizzleAdapter({
        db: {},
        provider: opts.provider,
      }),
    )
    .generateSchema("latest", opts.namespace);

  const output = opts.output ?? generated.path;
  const outPath = path.resolve(cwd, output);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, generated.code);
  console.log(`Schema generated: ${path.relative(cwd, outPath)}`);
};

export const schema = new Command("schema")
  .description("Database schema utilities")
  .addCommand(
    new Command("generate")
      .description("Generate an ORM schema file from the executor config")
      .option("-c, --cwd <cwd>", "the working directory", process.cwd())
      .option("--config <config>", "path to the executor config file")
      .option("--output <output>", "output file path for the generated schema")
      .option("--namespace <namespace>", "FumaDB namespace", "executor")
      .option("--adapter <adapter>", "FumaDB adapter", "drizzle")
      .option("--provider <provider>", "database provider", "postgresql")
      .option("--version <version>", "FumaDB schema version", "1.0.0")
      .action(schemaGenerateAction),
  );
