import { createClient, type Client, type InArgs, type Row } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Async libSQL test helper for the local migration/import suites. These tests
// used to open a synchronous bun:sqlite `Database` and call
// `.exec(sql)` / `.prepare(sql).run(...args)` / `.get(...args)` / `.all(...args)`.
// libSQL is async, so this thin wrapper keeps the same call shape (just awaited)
// over a single libSQL connection to the same `file:` URL — letting the suites
// run under plain Node vitest with no bun:sqlite dependency.
// ---------------------------------------------------------------------------

const toUrl = (path: string): string => (path === ":memory:" ? path : `file:${resolve(path)}`);

export class LibsqlTestDb {
  readonly client: Client;

  constructor(path: string = ":memory:") {
    this.client = createClient({ url: toUrl(path) });
  }

  /** Run one or more `;`-separated statements (bun:sqlite `.exec`). */
  async exec(sql: string): Promise<void> {
    await this.client.executeMultiple(sql);
  }

  /** Run a parameterized statement (bun:sqlite `.prepare(sql).run(...args)`). */
  async run(sql: string, ...args: unknown[]): Promise<void> {
    await this.client.execute({ sql, args: args as InArgs });
  }

  /** First row of a query (bun:sqlite `.prepare(sql).get(...args)`), or undefined. */
  async get<T = Row>(sql: string, ...args: unknown[]): Promise<T | undefined> {
    return (await this.client.execute({ sql, args: args as InArgs })).rows[0] as T | undefined;
  }

  /** All rows of a query (bun:sqlite `.prepare(sql).all(...args)`). */
  async all<T = Row>(sql: string, ...args: unknown[]): Promise<T[]> {
    // oxlint-disable-next-line executor/no-double-cast -- boundary: test helper narrows libSQL's structural `Row[]` to the caller's row type (the SQL is the contract)
    return (await this.client.execute({ sql, args: args as InArgs })).rows as unknown as T[];
  }

  /**
   * Prepared-statement shape mirroring bun:sqlite's `.prepare(sql)` so existing
   * suites keep their `.run(...) / .get(...) / .all(...)` chains (just awaited).
   */
  prepare(sql: string): LibsqlPreparedStatement {
    return new LibsqlPreparedStatement(this.client, sql);
  }

  close(): void {
    this.client.close();
  }
}

export class LibsqlPreparedStatement {
  constructor(
    private readonly client: Client,
    private readonly sql: string,
  ) {}

  async run(...args: unknown[]): Promise<void> {
    await this.client.execute({ sql: this.sql, args: args as InArgs });
  }

  async get<T = Row>(...args: unknown[]): Promise<T | undefined> {
    return (await this.client.execute({ sql: this.sql, args: args as InArgs })).rows[0] as
      | T
      | undefined;
  }

  async all<T = Row>(...args: unknown[]): Promise<T[]> {
    // oxlint-disable-next-line executor/no-double-cast -- boundary: test helper narrows libSQL's structural `Row[]` to the caller's row type (the SQL is the contract)
    return (await this.client.execute({ sql: this.sql, args: args as InArgs }))
      .rows as unknown as T[];
  }
}

/** Open a fresh in-memory or file-backed libSQL test DB. */
export const openTestDb = (path?: string): LibsqlTestDb => new LibsqlTestDb(path);

/** Open a libSQL client for a file path (caller closes it). */
export const openTestClient = (path: string): Client => createClient({ url: toUrl(path) });

/**
 * Replays drizzle migrations against a file DB through the libSQL migrator
 * (replaces `migrate(drizzle(new Database(path)), { migrationsFolder })`). Opens
 * and closes its own connection.
 */
export const runMigrations = async (path: string, migrationsFolder: string): Promise<void> => {
  const client = createClient({ url: toUrl(path) });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test migrator must close its connection whether or not the migration throws
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
  } finally {
    client.close();
  }
};
