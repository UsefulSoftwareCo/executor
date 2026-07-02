import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import { ConvexHttpClient } from "convex/browser";
import { drizzle as drizzleSqlite } from "drizzle-orm/libsql";
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  Kysely,
  MssqlDialect,
  MysqlDialect,
  PostgresDialect,
  SqliteDialect,
  sql,
} from "kysely";
import { MongoClient } from "mongodb";
import * as MySQL from "mysql2";
import { Pool } from "pg";
import * as Tarn from "tarn";
import * as Tedious from "tedious";
import { x } from "tinyexec";
import type { FumaDB, FumaDBFactory, Provider, SQLProvider } from "../src";
import { prismaAdapter } from "../src/adapters/prisma";
import type { AnySchema } from "../src/schema";

const sqlitePath = path.join(
  import.meta.dirname,
  "../node_modules/sqlite.sqlite",
);

function createDB<T extends string, Pool>(options: {
  provider: T;
  url: string;
  create: (url: string) => Pool;
}) {
  return {
    ...options,
    create(): Pool {
      return options.create(options.url);
    },
  };
}

export const databases = [
  createDB({
    provider: "postgresql",
    url: "postgresql://user:password@localhost:5434/postgresql",
    create(url) {
      return new Pool({
        connectionString: url,
      });
    },
  }),
  createDB({
    provider: "mysql",
    url: "mysql://root:password@localhost:3308/test",
    create(url) {
      return MySQL.createPool({
        uri: url,
        connectionLimit: 10,
      });
    },
  }),
  createDB({
    provider: "sqlite",
    url: `file:${sqlitePath}`,
    create(url) {
      return createClient({
        url,
      });
    },
  }),
  createDB({
    provider: "mongodb",
    url: "mongodb://localhost:27017/test?replicaSet=rs0&directConnection=true",
    create(url) {
      return new MongoClient(url);
    },
  }),
  createDB({
    provider: "convex",
    url: "http://127.0.0.1:3210",
    create(url) {
      return new ConvexHttpClient(url);
    },
  }),
  createDB({
    provider: "mssql",
    url: "mssql://sa:Password1234!@localhost:1433",
    create() {
      return new Tedious.Connection({
        authentication: {
          options: {
            userName: "sa",
            password: "Password1234!",
          },
          type: "default",
        },
        options: {
          port: 1433,
          trustServerCertificate: true,
          encrypt: false,
        },
        server: "localhost",
      });
    },
  }),
  createDB({
    provider: "cockroachdb",
    url: "postgresql://root:password@localhost:26257/test?sslmode=disable",
    create(url) {
      return new Pool({
        connectionString: url,
      });
    },
  }),
];

export const kyselyTests = [
  {
    db: new Kysely({
      dialect: new PostgresDialect({
        pool: databases.find((s) => s.provider === "postgresql")!.create(),
      }),
    }),
    provider: "postgresql" as const,
  },
  {
    db: new Kysely({
      dialect: new PostgresDialect({
        pool: databases.find((s) => s.provider === "cockroachdb")!.create(),
      }),
    }),
    provider: "cockroachdb" as const,
  },
  {
    provider: "mysql" as const,
    db: new Kysely({
      dialect: new MysqlDialect({
        pool: databases.find((s) => s.provider === "mysql")!.create(),
      }),
    }),
  },
  {
    provider: "sqlite" as const,
    db: new Kysely({
      dialect: new SqliteDialect({
        database: new Database(sqlitePath),
      }),
    }),
  },
  {
    provider: "mssql" as const,
    db: new Kysely({
      dialect: new MssqlDialect({
        tarn: {
          ...Tarn,
          options: {
            max: 10,
            min: 0,
          },
        },

        tedious: {
          ...Tedious,
          connectionFactory: () =>
            databases.find((db) => db.provider === "mssql")!.create(),
        },
      }),
    }),
  },
];

export const drizzleTests = [
  {
    provider: "postgresql" as const,
    db: (schema) =>
      drizzle({
        client: databases.find((s) => s.provider === "postgresql")!.create(),
        schema,
      }),
  },
  {
    provider: "mysql" as const,
    db: (schema) =>
      drizzleMysql({
        client: databases.find((s) => s.provider === "mysql")!.create(),
        schema,
        mode: "default",
      }),
  },
  {
    provider: "sqlite" as const,
    db: (schema) =>
      drizzleSqlite({
        client: databases.find((s) => s.provider === "sqlite")!.create(),
        schema,
      }),
  },
];

export const prismaTests = [
  {
    provider: "postgresql" as const,
  },
  {
    provider: "cockroachdb" as const,
  },
  {
    provider: "mysql" as const,
  },
  {
    provider: "sqlite" as const,
  },
];

const prismaDir = path.join(import.meta.dirname, "../node_modules/_prisma");
export async function initPrismaClient<
  Schemas extends AnySchema[],
  Version extends Schemas[number]["version"],
>(
  factory: FumaDBFactory<Schemas>,
  version: Version,
  provider: Exclude<Provider, "mongodb">,
): Promise<FumaDB<Schemas>> {
  fs.mkdirSync(prismaDir, { recursive: true });
  const hash = Date.now();
  const schemaPath = path.join(
    prismaDir,
    `schema-${hash}.${version}.${provider}.prisma`,
  );
  const db = databases.find((str) => str.provider === provider)!;
  const clientPath = path.join(
    prismaDir,
    `client-${hash}-${version}-${provider}`,
  );

  const schema = factory
    .client(
      prismaAdapter({
        prisma: {},
        provider,
      }),
    )
    .generateSchema(version);

  schema.path = schemaPath;
  schema.code += `\ndatasource db {
  provider = "${provider}"
}

generator client {
  provider = "prisma-client"
  output   = "${clientPath}"
}`;

  fs.writeFileSync(schema.path, schema.code);
  const env = {
    ...process.env,
    DATABASE_URL: db.url,
    PRISMA_SCHEMA: schemaPath,
  };

  // Push schema to database
  await x(
    "node",
    [
      "node_modules/prisma/build/index.js",
      "db",
      "push",
      "--force-reset",
      "--accept-data-loss",
    ],
    {
      nodeOptions: {
        cwd: path.dirname(import.meta.dirname),
        env,
      },
    },
  ).then((res) => console.log(res.stdout, res.stderr));
  // generate
  await x("node", ["node_modules/prisma/build/index.js", "generate"], {
    nodeOptions: {
      cwd: path.dirname(import.meta.dirname),
      env,
    },
  }).then((res) => console.log(res.stdout, res.stderr));

  const { PrismaClient } = await import(`${clientPath}/client`);
  let adapter;
  switch (provider) {
    case "mysql":
      const { PrismaMariaDb } = await import("@prisma/adapter-mariadb");
      adapter = new PrismaMariaDb(db.url);
      break;
    case "cockroachdb":
    case "postgresql":
      const { PrismaPg } = await import("@prisma/adapter-pg");
      adapter = new PrismaPg({ connectionString: db.url });
      break;
    case "sqlite":
      const { PrismaBetterSqlite3 } =
        await import("@prisma/adapter-better-sqlite3");
      adapter = new PrismaBetterSqlite3({ url: db.url });
      break;
    case "mssql":
      const { PrismaMssql } = await import("@prisma/adapter-mssql");
      adapter = new PrismaMssql({ connectionString: db.url });
      break;
    default:
      const _: never = provider;
  }

  return factory.client(
    prismaAdapter({
      prisma: new PrismaClient({ adapter }),
      provider,
      db: db.provider === "mongodb" ? db.create() : undefined,
    }),
  );
}

export async function initDrizzleClient<
  Schemas extends AnySchema[],
  Version extends Schemas[number]["version"],
>(
  factory: FumaDBFactory<Schemas>,
  version: Version,
  provider: Exclude<SQLProvider, "mssql" | "cockroachdb">,
) {
  const DrizzleAPI = await import("drizzle-kit/api");
  const { drizzleAdapter } = await import("../src/adapters/drizzle");
  const test = drizzleTests.find((t) => t.provider === provider)!;

  const db = test.db({});

  const schema = factory
    .client(
      drizzleAdapter({
        db,
        provider,
      }),
    )
    .generateSchema(version);

  schema.path = path.join(import.meta.dirname, `drizzle-schema.${provider}.ts`);
  fs.writeFileSync(schema.path, schema.code);
  const drizzleSchema = await import(`${schema.path}?hash=${Date.now()}`);

  if (provider === "postgresql") {
    const { apply } = await DrizzleAPI.pushSchema(drizzleSchema, db as any);
    await apply();
  } else if (provider === "mysql") {
    const { sql } = await import("drizzle-orm");
    const prev = await DrizzleAPI.generateMySQLDrizzleJson({});
    const cur = await DrizzleAPI.generateMySQLDrizzleJson(drizzleSchema);
    const statements = await DrizzleAPI.generateMySQLMigration(prev, cur);

    for (const statement of statements) {
      await (db as any).execute(sql.raw(statement));
    }
  } else {
    // they need libsql
    const { apply } = await DrizzleAPI.pushSQLiteSchema(
      drizzleSchema,
      db as any,
    );
    await apply();
  }

  fs.rmSync(schema.path);
  return factory.client(
    drizzleAdapter({
      db: test.db(drizzleSchema),
      provider,
    }),
  );
}

export const cleanupFiles = () => {
  fs.rmSync(sqlitePath);

  if (fs.existsSync(prismaDir))
    fs.rmSync(prismaDir, { recursive: true, force: true });
};

const mongoReplicaSetConfig = {
  _id: "rs0",
  members: [{ _id: 0, host: "localhost:27017" }],
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isMongoError(error: unknown, codeName: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "codeName" in error &&
    error.codeName === codeName
  );
}

async function ensureMongoPrimary(mongodb: MongoClient) {
  const admin = mongodb.db("admin");

  try {
    await admin.command({ replSetGetStatus: 1 });
  } catch (error) {
    if (isMongoError(error, "NotYetInitialized")) {
      await admin.command({ replSetInitiate: mongoReplicaSetConfig });
    } else if (
      isMongoError(error, "InvalidReplicaSetConfig") ||
      (error instanceof Error && error.message.includes("not a member"))
    ) {
      await admin.command({
        replSetReconfig: mongoReplicaSetConfig,
        force: true,
      });
    } else {
      throw error;
    }
  }

  for (let i = 0; i < 30; i++) {
    const hello = await admin.command({ hello: 1 });
    if (hello.isWritablePrimary) return;

    await wait(500);
  }

  throw new Error("Timed out waiting for MongoDB replica set primary.");
}

export async function resetMongoDB(mongodb: MongoClient) {
  await ensureMongoPrimary(mongodb);
  await mongodb.db().dropDatabase();
}

export async function resetDB(provider: SQLProvider) {
  const kysely = kyselyTests.find((kysely) => kysely.provider === provider)!;
  const db = kysely.db as Kysely<any>;

  if (provider === "mysql") {
    await db.transaction().execute(async () => {
      await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(db);
      const tables = await db
        .selectFrom("information_schema.tables")
        .select("TABLE_NAME")
        .where((b) =>
          b.or([
            b("TABLE_SCHEMA", "not in", [
              "mysql",
              "performance_schema",
              "information_schema",
              "sys",
            ]),
            b("TABLE_NAME", "=", "__drizzle_migrations"),
          ]),
        )
        .where("TABLE_TYPE", "=", "BASE TABLE")
        .execute();
      for (const table of tables) {
        await db.schema.dropTable(table.TABLE_NAME).ifExists().execute();
      }

      await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db);
    });

    return;
  }

  if (provider === "sqlite") {
    const tables = await db
      .selectFrom("sqlite_master")
      .select("name")
      .where("type", "=", "table")
      .where("name", "not like", "sqlite_%")
      .execute();

    await sql`PRAGMA foreign_keys = OFF`.execute(db);
    await Promise.all(
      tables.map((table) =>
        db.schema.dropTable(table.name).ifExists().execute(),
      ),
    );
    await sql`PRAGMA foreign_keys = ON`.execute(db);
    return;
  }

  if (provider === "postgresql" || provider === "cockroachdb") {
    const tables = await db
      .selectFrom("information_schema.tables")
      .select(["table_schema", "table_name"])
      .where("table_type", "=", "BASE TABLE")
      .where("table_schema", "not in", [
        "pg_catalog",
        "information_schema",
        "crdb_internal",
      ])
      .execute();

    for (const t of tables) {
      await db.schema
        .dropTable(`${t.table_schema}.${t.table_name}`)
        .ifExists()
        .cascade()
        .execute();
    }
    return;
  }

  if (provider === "mssql") {
    const tables = await db
      .selectFrom("information_schema.tables")
      .select(["table_schema", "table_name", "ss.schema_id"])
      .where("table_type", "=", "BASE TABLE")
      .where("table_schema", "not in", ["sys", "INFORMATION_SCHEMA"])
      .innerJoin("sys.schemas as ss", "table_schema", "ss.name")
      .execute();

    await Promise.all(
      tables.map(async (t) => {
        const constraints = await db
          .selectFrom("sys.foreign_keys as fk")
          .innerJoin("sys.objects as o", "fk.parent_object_id", "o.object_id")
          .select(["fk.name as constraint_name"])
          .where("o.name", "=", t.table_name)
          .where("o.schema_id", "=", t.schema_id)
          .execute();

        for (const { constraint_name } of constraints) {
          await db.schema
            .alterTable(t.table_name)
            .dropConstraint(constraint_name)
            .execute();
        }
      }),
    );

    await Promise.all(
      tables.map(async (t) => {
        await db.schema.dropTable(t.table_name).execute();
      }),
    );
    return;
  }

  const tables = await db
    .selectFrom("information_schema.tables")
    .select(["table_schema", "table_name"])
    .where("table_type", "=", "BASE TABLE")
    .where("table_schema", "not in", [
      "crdb_internal",
      "pg_catalog",
      "information_schema",
      "public",
    ])
    .execute();

  await Promise.all(
    tables.map((t) =>
      db.schema
        .dropTable(`${t.table_schema}.${t.table_name}`)
        .ifExists()
        .execute(),
    ),
  );
}
