/* oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: deployment CLI connection acquisition */

import { setTimeout } from "node:timers/promises";

const MAX_ATTEMPTS = 7;
const RETRY_DELAY_MS = 10_000;

/**
 * Validate the deploy transport without logging credentials. PlanetScale schema
 * migrations use the direct endpoint because code migrations hold session locks.
 */
export const directDatabaseUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol");
  }
  if (url.hostname.endsWith(".psdb.cloud") && url.port !== "" && url.port !== "5432") {
    throw new Error("PlanetScale deploy scripts require the direct endpoint on port 5432");
  }
  return value;
};

/**
 * Open the CLI's single connection before starting work. Retry only PostgreSQL
 * admission failures (53300), at most six times with ten seconds between tries.
 * The caller must set connect_timeout and close the client on every exit.
 * Migration and readiness mutations remain outside this retry boundary.
 */
export const waitForDatabaseConnection = async (
  sql: { readonly unsafe: (query: string) => PromiseLike<unknown> },
  options: {
    readonly log: (message: string) => void;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<void> => {
  const sleep = options.sleep ?? ((milliseconds: number) => setTimeout(milliseconds));
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await sql.unsafe("SELECT 1");
      return;
    } catch (cause) {
      const isCapacityError =
        typeof cause === "object" && cause !== null && "code" in cause && cause.code === "53300";
      if (!isCapacityError || attempt === MAX_ATTEMPTS) throw cause;
      options.log(
        `Database connection capacity is full (53300). Retrying connection ${attempt}/${MAX_ATTEMPTS - 1} in 10s; no work has started.`,
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
};
