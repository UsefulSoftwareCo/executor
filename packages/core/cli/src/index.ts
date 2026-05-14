#!/usr/bin/env node

import { Command } from "commander";
import { schema } from "./commands/schema.js";

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

const program = new Command("executor-sdk")
  .version("0.0.1")
  .description("Executor SDK CLI")
  .addCommand(schema)
  .action(() => program.help());

await program.parseAsync();
