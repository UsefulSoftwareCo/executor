import { createDrizzleRuntimeSchemaFromTables } from "@executor-js/fumadb/adapters/drizzle";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  OPEN_AGENTS_EXECUTOR_DB_PROVIDER,
  OPEN_AGENTS_EXECUTOR_NAMESPACE,
  OPEN_AGENTS_EXECUTOR_SCHEMA_VERSION,
  openAgentsExecutorTables,
} from "./db-definition";

type ExecutorDrizzleSchema = {
  readonly integration: PgTable;
  readonly connection: PgTable;
  readonly oauth_client: PgTable;
  readonly oauth_session: PgTable;
  readonly tool: PgTable;
  readonly definition: PgTable;
  readonly tool_policy: PgTable;
  readonly plugin_storage: PgTable;
  readonly blob: PgTable;
  readonly private_open_agents_executor_settings: PgTable;
};

const executorSchema = createDrizzleRuntimeSchemaFromTables({
  tables: openAgentsExecutorTables,
  namespace: OPEN_AGENTS_EXECUTOR_NAMESPACE,
  version: OPEN_AGENTS_EXECUTOR_SCHEMA_VERSION,
  provider: OPEN_AGENTS_EXECUTOR_DB_PROVIDER,
}) as ExecutorDrizzleSchema;

export const integration = executorSchema.integration;
export const connection = executorSchema.connection;
export const oauth_client = executorSchema.oauth_client;
export const oauth_session = executorSchema.oauth_session;
export const tool = executorSchema.tool;
export const definition = executorSchema.definition;
export const tool_policy = executorSchema.tool_policy;
export const plugin_storage = executorSchema.plugin_storage;
export const blob = executorSchema.blob;
export const private_open_agents_executor_settings =
  executorSchema.private_open_agents_executor_settings;
