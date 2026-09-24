import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { StateStoreError, type StateService } from "alchemy/State/State";
import { apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import { reconcileAppDomainStack } from "../src/implementation/app-domain-stack.ts";

const RecordInput = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  content: Schema.String,
  proxied: Schema.Boolean,
  ttl: Schema.Number,
  comment: Schema.String,
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});
type DnsRecord = typeof RecordInput.Type & { readonly id: string };

test("Alchemy owns team DNS through retries, rename, deletion, and unrelated records", async (context) => {
  const records = new Map<string, DnsRecord>();
  const unmanaged = {
    id: "unmanaged",
    name: "*.other.fixture.test",
    type: "AAAA",
    content: "100::",
    proxied: true,
    ttl: 1,
    comment: "Another stage",
  };
  records.set(unmanaged.id, unmanaged);
  let sequence = 0;
  let writes = 0;
  let reads = 0;
  let deleteRequests = 0;
  let createRequests = 0;
  const readPaths: string[] = [];
  let denyReads = false;
  let denyDeletes = false;
  let omitDeletionAcknowledgement = false;
  let omitCreationAcknowledgement = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET") {
        reads++;
        readPaths.push(request.url!);
      }
      if (request.method === "GET" && denyReads) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "Synthetic read failure" }],
          }),
        );
        return;
      }
      if ((request.method === "DELETE" || request.url?.endsWith("/batch")) && denyDeletes) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "Synthetic permission failure" }],
          }),
        );
        return;
      }
      const url = new URL(request.url ?? "/", "http://fixture.test");
      const id = url.pathname.split("/")[4];
      let result: unknown;
      if (request.method === "POST" && url.pathname.endsWith("/batch")) {
        let body = "";
        for await (const chunk of request) body += chunk.toString();
        const input = Schema.decodeUnknownSync(
          Schema.Struct({
            deletes: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
            posts: Schema.optionalKey(Schema.Array(RecordInput)),
          }),
        )(JSON.parse(body));
        const deletes = input.deletes ?? [];
        const posts = input.posts ?? [];
        if (deletes.length > 0) deleteRequests++;
        if (posts.length > 0) createRequests++;
        assert.ok(deletes.length + posts.length <= 100);
        assert.ok(deletes.every(({ id }) => records.has(id)));
        const deleted = deletes.map(({ id }) => ({
          id,
          type: "AAAA",
          created_on: "2026-01-01T00:00:00Z",
          modified_on: "2026-01-01T00:00:00Z",
          proxiable: true,
          meta: {},
        }));
        for (const { id } of deletes) {
          records.delete(id);
          writes++;
        }
        const created = posts.map((input) => {
          assert.ok(!Array.from(records.values()).some((record) => record.name === input.name));
          const record = { ...input, id: `record-${++sequence}` };
          records.set(record.id, record);
          writes++;
          return record;
        });
        result =
          omitDeletionAcknowledgement || omitCreationAcknowledgement
            ? {}
            : { deletes: deleted, posts: created };
      } else if (url.pathname === "/zones/zone") result = { id: "zone", name: "fixture.test" };
      else if (request.method === "GET" && id === undefined) {
        result = Array.from(records.values()).filter(
          (record) =>
            (!url.searchParams.has("name.exact") ||
              record.name === url.searchParams.get("name.exact")) &&
            (!url.searchParams.has("name.endswith") ||
              record.name.endsWith(url.searchParams.get("name.endswith")!)) &&
            (!url.searchParams.has("type") || record.type === url.searchParams.get("type")),
        );
        if (Number(url.searchParams.get("page") ?? 1) > 1) result = [];
      } else if (request.method === "GET") result = records.get(id ?? "");
      else if (request.method === "DELETE") {
        deleteRequests++;
        writes++;
        records.delete(id ?? "");
        result = { id };
      } else {
        if (request.method === "POST") createRequests++;
        let body = "";
        for await (const chunk of request) body += chunk.toString();
        const input = Schema.decodeUnknownSync(RecordInput)(JSON.parse(body));
        const record = { ...input, id: id ?? `record-${++sequence}` };
        records.set(record.id, record);
        writes++;
        result = record;
      }
      response.writeHead(result === undefined ? 404 : 200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: result !== undefined,
          result,
          errors: result === undefined ? [{ code: 81044, message: "Record does not exist." }] : [],
          messages: [],
          result_info: {
            page: Number(url.searchParams.get("page") ?? 1),
            per_page: 100,
            total_pages: 1,
            count: Array.isArray(result) ? result.length : 1,
            total_count: Array.isArray(result) ? result.length : 1,
          },
        }),
      );
    } catch {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: "Fixture request failed" }],
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const state = await Effect.runPromise(InMemoryService());
  let interruptCommit = true;
  const journal: StateService = {
    ...state,
    set: (request) => {
      if (interruptCommit && request.value.status === "created") {
        interruptCommit = false;
        return Effect.fail(
          new StateStoreError({ message: "Synthetic interruption after DNS creation" }),
        );
      }
      return state.set(request);
    },
  };
  const credentials = apiTokenCredentials({
    apiToken: "synthetic",
    apiBaseUrl: `http://127.0.0.1:${address.port}`,
  });
  const run = (teams: ReadonlyArray<{ id: string; slug: string }>) =>
    Effect.runPromise(
      reconcileAppDomainStack({
        stage: "fixture",
        accountId: "fixture-account",
        zoneId: "zone",
        zoneName: "fixture.test",
        suffix: "fixture.test",
        credentials,
        state: journal,
        teams,
      }),
    );
  await assert.rejects(run([{ id: "team-a", slug: "alpha" }]));
  await run([
    { id: "team-a", slug: "alpha" },
    { id: "team-b", slug: "beta" },
  ]);
  assert.deepEqual(
    Array.from(records.values(), (record) => record.name).sort(),
    ["*.alpha.fixture.test", "*.beta.fixture.test", unmanaged.name].sort(),
  );
  const initialWrites = writes;
  const initialReads = reads;
  await run([
    { id: "team-a", slug: "alpha" },
    { id: "team-b", slug: "beta" },
  ]);
  assert.equal(writes, initialWrites);
  assert.ok(reads - initialReads === 1, "Stable domains need exactly one inventory page");
  assert.ok(
    readPaths.slice(initialReads).every((path) => path.split("?")[0] === "/zones/zone/dns_records"),
    "An unchanged fleet must not issue individual record reads",
  );
  const alpha = Array.from(records.values()).find(
    (record) => record.name === "*.alpha.fixture.test",
  );
  assert.ok(alpha);
  records.set(alpha.id, { ...alpha, content: "100::1" });
  await run([
    { id: "team-a", slug: "alpha" },
    { id: "team-b", slug: "beta" },
  ]);
  assert.equal(
    records.get(alpha.id)?.content,
    "100::",
    "The live inventory must detect and repair external drift",
  );
  denyReads = true;
  const beforeDeniedRead = writes;
  await assert.rejects(run([]));
  assert.equal(
    writes,
    beforeDeniedRead,
    "Failed inventory must never be treated as an empty fleet",
  );
  denyReads = false;
  // DNS belongs to the hostname. Reusing a released slug must not make two
  // independent resources compete for the same physical record.
  await run([{ id: "team-c", slug: "alpha" }]);
  assert.deepEqual(
    Array.from(records.values(), (record) => record.name).sort(),
    ["*.alpha.fixture.test", unmanaged.name].sort(),
  );
  assert.ok(
    Array.from(records.values())
      .find((record) => record.name === "*.alpha.fixture.test")
      ?.comment.includes("[alchemy:"),
  );
  await run([{ id: "team-a", slug: "renamed" }]);
  assert.deepEqual(
    Array.from(records.values(), (record) => record.name).sort(),
    ["*.renamed.fixture.test", unmanaged.name].sort(),
  );
  denyDeletes = true;
  await assert.rejects(run([]));
  assert.equal(records.size, 2);
  assert.ok(
    (await Effect.runPromise(state.list({ stack: "executor-team-domains", stage: "fixture" })))
      .length > 0,
  );
  denyDeletes = false;
  await run([]);
  assert.deepEqual(Array.from(records.values()), [unmanaged]);
  assert.deepEqual(
    await Effect.runPromise(state.list({ stack: "executor-team-domains", stage: "fixture" })),
    [],
  );
  const beforeBatch = reads;
  const beforeCreates = createRequests;
  await run(
    Array.from({ length: 120 }, (_, index) => ({ id: `batch-${index}`, slug: `batch-${index}` })),
  );
  assert.ok(
    reads - beforeBatch <= 6,
    "A burst of 120 organizations must use bounded inventory scans",
  );
  assert.ok(createRequests - beforeCreates <= 3, "New domains must use provider batches");
  assert.ok(
    readPaths.slice(beforeBatch).every((path) => path.split("?")[0] !== "/zones/zone"),
    "The known authoritative zone must not be fetched again for every new record",
  );
  assert.equal(records.size, 121);
  // A record deleted outside Alchemy must remain an idempotent cleanup.
  const missing = Array.from(records.values()).find(
    (record) => record.name === "*.batch-0.fixture.test",
  );
  assert.ok(missing);
  records.delete(missing.id);
  const beforeDeleteBatch = deleteRequests;
  await run([]);
  assert.ok(
    deleteRequests - beforeDeleteBatch <= 3,
    `Cleanup must batch the 120 owned records; received ${deleteRequests - beforeDeleteBatch} requests`,
  );
  assert.deepEqual(Array.from(records.values()), [unmanaged]);
  await run([{ id: "unconfirmed", slug: "unconfirmed" }]);
  omitDeletionAcknowledgement = true;
  await assert.rejects(run([]));
  assert.deepEqual(Array.from(records.values()), [unmanaged]);
  assert.ok(
    (await Effect.runPromise(state.list({ stack: "executor-team-domains", stage: "fixture" })))
      .length > 0,
  );
  omitDeletionAcknowledgement = false;
  await run([]);
  assert.deepEqual(
    await Effect.runPromise(state.list({ stack: "executor-team-domains", stage: "fixture" })),
    [],
  );
  omitCreationAcknowledgement = true;
  await assert.rejects(run([{ id: "unconfirmed-create", slug: "unconfirmed-create" }]));
  assert.equal(records.size, 2, "the provider created the record before losing acknowledgement");
  omitCreationAcknowledgement = false;
  await run([{ id: "unconfirmed-create", slug: "unconfirmed-create" }]);
  assert.equal(records.size, 2, "the ownership marker must recover the existing record");
  await run([]);
  assert.deepEqual(Array.from(records.values()), [unmanaged]);
  const foreignState = await Effect.runPromise(InMemoryService());
  await assert.rejects(
    Effect.runPromise(
      reconcileAppDomainStack({
        stage: "foreign-attempt",
        accountId: "fixture-account",
        zoneId: "zone",
        zoneName: "fixture.test",
        suffix: "fixture.test",
        credentials,
        state: foreignState,
        teams: [{ id: "another-team", slug: "other" }],
      }),
    ),
  );
  assert.deepEqual(Array.from(records.values()), [unmanaged]);
});
