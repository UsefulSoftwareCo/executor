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
  let denyDeletes = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "DELETE" && denyDeletes) {
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
      if (url.pathname === "/zones/zone") result = { id: "zone", name: "fixture.test" };
      else if (request.method === "GET" && id === undefined) {
        result = Array.from(records.values()).filter(
          (record) =>
            (!url.searchParams.has("name.exact") ||
              record.name === url.searchParams.get("name.exact")) &&
            (!url.searchParams.has("type") || record.type === url.searchParams.get("type")),
        );
      } else if (request.method === "GET") result = records.get(id ?? "");
      else if (request.method === "DELETE") {
        writes++;
        records.delete(id ?? "");
        result = { id };
      } else {
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
            page: 1,
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
  await run([
    { id: "team-a", slug: "alpha" },
    { id: "team-b", slug: "beta" },
  ]);
  assert.equal(writes, initialWrites);
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
  const foreignState = await Effect.runPromise(InMemoryService());
  await assert.rejects(
    Effect.runPromise(
      reconcileAppDomainStack({
        stage: "foreign-attempt",
        accountId: "fixture-account",
        zoneId: "zone",
        suffix: "fixture.test",
        credentials,
        state: foreignState,
        teams: [{ id: "another-team", slug: "other" }],
      }),
    ),
  );
  assert.deepEqual(Array.from(records.values()), [unmanaged]);
});
