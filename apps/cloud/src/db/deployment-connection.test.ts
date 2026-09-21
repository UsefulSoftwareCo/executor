/* oxlint-disable executor/no-promise-reject -- boundary: simulate the Postgres.js driver's rejected promises */

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { directDatabaseUrl, waitForDatabaseConnection } from "../../scripts/database-connection";

describe("deployment database connection", () => {
  it.effect("waits for admission before allowing deployment work", () =>
    Effect.promise(async () => {
      let remainingFailures = 2;
      const waits: number[] = [];
      const logs: string[] = [];
      const queries: string[] = [];
      await waitForDatabaseConnection(
        {
          unsafe: (query) => {
            queries.push(query);
            return remainingFailures-- > 0
              ? Promise.reject({ code: "53300", detail: "private connection data" })
              : Promise.resolve([]);
          },
        },
        {
          log: (line) => logs.push(line),
          sleep: async (ms) => {
            waits.push(ms);
          },
        },
      );
      expect(queries).toEqual(["SELECT 1", "SELECT 1", "SELECT 1"]);
      expect(waits).toEqual([10_000, 10_000]);
      expect(logs).toHaveLength(2);
      expect(logs.join()).not.toContain("private connection data");
    }),
  );

  it.effect("fails after the bounded admission budget", () =>
    Effect.promise(async () => {
      const failure = { code: "53300" };
      let attempts = 0;
      const waits: number[] = [];
      await expect(
        waitForDatabaseConnection(
          {
            unsafe: () => {
              attempts += 1;
              return Promise.reject(failure);
            },
          },
          {
            log: () => {},
            sleep: async (ms) => {
              waits.push(ms);
            },
          },
        ),
      ).rejects.toBe(failure);
      expect(attempts).toBe(7);
      expect(waits).toEqual(Array(6).fill(10_000));
    }),
  );

  it.effect("fails immediately for authentication, transport and SQL errors", () =>
    Effect.promise(async () => {
      for (const code of ["28P01", "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "42601", "40001"]) {
        const failure = { code };
        const waits: number[] = [];
        await expect(
          waitForDatabaseConnection(
            { unsafe: () => Promise.reject(failure) },
            {
              log: () => {},
              sleep: async (ms) => {
                waits.push(ms);
              },
            },
          ),
        ).rejects.toBe(failure);
        expect(waits).toEqual([]);
      }
    }),
  );

  it("keeps PlanetScale deployment traffic on the direct endpoint", () => {
    const direct = "postgres://example:secret@region.pg.psdb.cloud:5432/database";
    expect(directDatabaseUrl(direct)).toBe(direct);
    expect(directDatabaseUrl("postgres://localhost:25432/postgres")).toContain(":25432");
    expect(() => directDatabaseUrl(direct.replace(":5432", ":6432"))).toThrow("direct endpoint");
    expect(() => directDatabaseUrl("invalid-secret")).toThrow("valid PostgreSQL URL");
    expect(() => directDatabaseUrl("https://localhost/database")).toThrow("protocol");
  });
});
