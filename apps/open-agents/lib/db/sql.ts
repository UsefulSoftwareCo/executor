import postgres from "postgres";

const DB_POOL_MAX_CONNECTIONS = 1;
const DB_IDLE_TIMEOUT_SECONDS = 10;
const DB_APPLICATION_NAME_PREFIX = `open-agents:${process.env.NODE_ENV}`;

type PostgresClient = ReturnType<typeof postgres>;

type DbConnectionSnapshot = {
  applicationName: string | null;
  state: string | null;
  count: number;
};

const globalForSql = globalThis as typeof globalThis & {
  openAgentsDbSql?: PostgresClient;
  openAgentsDbPoolSerial?: number;
};

function createSqlClient(): PostgresClient {
  if (!process.env.POSTGRES_URL) {
    throw new Error("POSTGRES_URL environment variable is required");
  }

  globalForSql.openAgentsDbPoolSerial = (globalForSql.openAgentsDbPoolSerial ?? 0) + 1;
  const applicationName = `${DB_APPLICATION_NAME_PREFIX}:pid${process.pid}:pool${globalForSql.openAgentsDbPoolSerial}`;

  if (process.env.NODE_ENV === "development") {
    console.info("[db] creating postgres pool", {
      applicationName,
      idleTimeoutSeconds: DB_IDLE_TIMEOUT_SECONDS,
      maxConnections: DB_POOL_MAX_CONNECTIONS,
      pid: process.pid,
      poolSerial: globalForSql.openAgentsDbPoolSerial,
    });
  }

  return postgres(process.env.POSTGRES_URL, {
    connection: { application_name: applicationName },
    idle_timeout: DB_IDLE_TIMEOUT_SECONDS,
    max: DB_POOL_MAX_CONNECTIONS,
    onnotice: () => {},
  });
}

export const sqlClient = (globalForSql.openAgentsDbSql ??= createSqlClient());

export async function getDbConnectionSnapshot(): Promise<DbConnectionSnapshot[]> {
  return sqlClient<DbConnectionSnapshot[]>`
    select
      application_name as "applicationName",
      state,
      count(*)::int as count
    from pg_stat_activity
    where datname = current_database()
    group by application_name, state
    order by application_name, state
  `;
}
