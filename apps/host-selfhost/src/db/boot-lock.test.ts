import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { expect, test } from "@effect/vitest";

import { withSelfHostBootLock } from "./boot-lock";

test("serializes concurrent startup work across database clients", async () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), "executor-boot-lock-")), "lock.db");
  const firstClient = createClient({ url: `file:${databasePath}` });
  const secondClient = createClient({ url: `file:${databasePath}` });
  let active = 0;
  let maximumActive = 0;

  const run = (client: typeof firstClient) =>
    withSelfHostBootLock(
      client,
      async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
      },
      { leaseMs: 300, pollMs: 5, waitTimeoutMs: 1_000 },
    );

  await Promise.all([run(firstClient), run(secondClient)]);

  expect(maximumActive).toBe(1);
  firstClient.close();
  secondClient.close();
});

test("takes over an expired startup lease", async () => {
  const client = createClient({ url: ":memory:" });
  await client.execute(
    "CREATE TABLE executor_boot_lock (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  );
  await client.execute({
    sql: "INSERT INTO executor_boot_lock (name, owner, expires_at) VALUES (?, ?, ?)",
    args: ["startup", "crashed-container", Date.now() - 1],
  });

  const result = await withSelfHostBootLock(client, async () => "recovered", {
    leaseMs: 300,
    pollMs: 5,
    takeoverGraceMs: 20,
    waitTimeoutMs: 100,
  });

  expect(result).toBe("recovered");
  client.close();
});

test("keeps ownership while boot work holds SQLite's writer lock", async () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), "executor-boot-busy-")), "lock.db");
  const lockClient = createClient({ url: `file:${databasePath}` });
  const bootClient = createClient({ url: `file:${databasePath}` });
  const lockOptions = {
    leaseMs: 180,
    pollMs: 10,
    takeoverGraceMs: 80,
    waitTimeoutMs: 1_000,
  } as const;

  const result = await withSelfHostBootLock(
    lockClient,
    async () => {
      await bootClient.execute("BEGIN IMMEDIATE");
      await new Promise((resolve) => setTimeout(resolve, 160));
      await bootClient.execute("COMMIT");
      await new Promise((resolve) => setTimeout(resolve, 40));
      return "completed";
    },
    lockOptions,
  );

  expect(result).toBe("completed");
  lockClient.close();
  bootClient.close();
});
