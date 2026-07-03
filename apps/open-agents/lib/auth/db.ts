import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/auth-schema";
import { sqlClient } from "../db/sql";

type AuthDbClient = ReturnType<typeof drizzle<typeof schema>>;

const globalForAuthDb = globalThis as typeof globalThis & {
  openAgentsAuthDb?: AuthDbClient;
};

export const authDb = (globalForAuthDb.openAgentsAuthDb ??= drizzle(sqlClient, { schema }));
