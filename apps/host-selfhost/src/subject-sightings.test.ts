import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { afterAll, beforeAll, expect, test } from "@effect/vitest";
import { withQueryContext } from "@executor-js/fumadb/query";

import { makeScopedExecutor } from "@executor-js/api/server";

import { createSelfHostDb, SelfHostDb } from "./db/self-host-db";
import { SelfHostScopedExecutorSeams } from "./execution";
import type { SelfHostPlugins } from "./plugins";

// The `subject` table is populated at the request seam: `makeScopedExecutor` is
// what every HTTP request and MCP session on every host passes through, so
// building a scoped executor IS a sighting. Exercised here against a real host's
// seams (long-lived SQLite DbProvider + real plugins) rather than a stub, since
// the point is that the production wiring reaches the writer at all.

const createScopedExecutor = (accountId: string, organizationId: string) =>
  makeScopedExecutor<SelfHostPlugins>(accountId, organizationId, "Default").pipe(
    Effect.provide(SelfHostScopedExecutorSeams),
  );

const dataDir = mkdtempSync(join(tmpdir(), "eh-subj-"));
process.env.EXECUTOR_DATA_DIR = dataDir;

let dbLayer!: Layer.Layer<SelfHostDb>;
let dbHandle: Awaited<ReturnType<typeof createSelfHostDb>> | undefined;

beforeAll(async () => {
  dbHandle = await createSelfHostDb({
    path: join(dataDir, "data.db"),
    namespace: "executor_selfhost",
    version: "1.0.0",
  });
  dbLayer = Layer.succeed(SelfHostDb)(dbHandle);
});
afterAll(async () => {
  await dbHandle?.close();
});

const subjectsOf = async (tenant: string): Promise<readonly string[]> => {
  const rows = await withQueryContext(dbHandle!.db, {
    tenant,
    subject: null,
  }).findMany("subject", {
    orderBy: ["external_id", "asc"],
  });
  return rows.map((row) => String(row.external_id));
};

test("building a scoped executor records the acting principal", async () => {
  const before = Date.now();
  await Effect.runPromise(
    createScopedExecutor("alice", "sightings-org").pipe(Effect.provide(dbLayer), Effect.asVoid),
  );

  expect(await subjectsOf("sightings-org")).toEqual(["alice"]);

  const [row] = await withQueryContext(dbHandle!.db, {
    tenant: "sightings-org",
    subject: null,
  }).findMany("subject", {});
  expect(Number(row?.last_seen_at)).toBeGreaterThanOrEqual(before);
});

test("repeat requests from several members converge on one row each", async () => {
  const org = "sightings-org-2";
  await Effect.runPromise(
    Effect.forEach(
      ["alice", "alice", "bob", "alice"],
      (accountId) => createScopedExecutor(accountId, org).pipe(Effect.asVoid),
      { discard: true },
    ).pipe(Effect.provide(dbLayer)),
  );

  // Four requests, two principals, two rows: the sighting is an upsert, and
  // the repeat sightings are absorbed by the throttle rather than duplicating.
  expect(await subjectsOf(org)).toEqual(["alice", "bob"]);
});
