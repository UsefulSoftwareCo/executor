import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { sqlClient } from "./sql";

type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

const globalForDb = globalThis as typeof globalThis & {
  openAgentsDb?: DrizzleClient;
};

export const db = (globalForDb.openAgentsDb ??= drizzle(sqlClient, { schema }));

export { getDbConnectionSnapshot } from "./sql";
