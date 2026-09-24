import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import {
  appDomainCertificates,
  appDomainDnsRecords,
} from "../src/implementation/app-domain-inventory.ts";

test("domain inventories include every page and stop at the provider's reported end", async (context) => {
  const requests: string[] = [];
  let reportEnd = true;
  let denySecondPage = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.test");
    const page = Number(url.searchParams.get("page"));
    requests.push(`${url.pathname}?page=${page}`);
    response.setHeader("content-type", "application/json");
    if (denySecondPage && page === 2) {
      response.writeHead(403);
      response.end(
        JSON.stringify({ success: false, errors: [{ code: 10000, message: "Synthetic denial" }] }),
      );
      return;
    }
    const certificate = url.pathname.endsWith("/certificate_packs");
    const item = certificate
      ? {
          id: `certificate-${page}`,
          certificates: [],
          hosts: [`*.team-${page}.fixture.test`],
          status: "pending_validation",
          type: "total_tls",
        }
      : {
          id: `record-${page}`,
          name: `*.team-${page}.fixture.test`,
          type: "AAAA",
          content: "100::",
          ttl: 1,
          proxied: true,
        };
    response.end(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: page <= 2 ? [item] : [],
        result_info: {
          page,
          per_page: 1,
          ...(reportEnd ? { total_pages: 2, total_count: 2 } : {}),
        },
      }),
    );
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
  const credentials = apiTokenCredentials({
    apiToken: "synthetic",
    apiBaseUrl: `http://127.0.0.1:${address.port}`,
  });
  const run = <A, E>(
    operation: Effect.Effect<
      A,
      E,
      Credentials | import("effect/unstable/http/HttpClient").HttpClient
    >,
  ) =>
    Effect.runPromise(
      operation.pipe(
        Effect.provideService(Credentials, Effect.succeed(credentials)),
        Effect.provide(FetchHttpClient.layer),
      ),
    );
  for (const operation of [
    appDomainCertificates("zone").pipe(Effect.map((items) => items.map((item) => item.id))),
    appDomainDnsRecords("zone", "fixture.test").pipe(
      Effect.map((items) => items.map((item) => item.id)),
    ),
  ]) {
    requests.length = 0;
    const items = await run(operation);
    assert.equal(items.length, 2);
    assert.notEqual(items[0], items[1]);
    assert.equal(requests.length, 2, "The last nonempty page must end traversal");
    reportEnd = false;
    requests.length = 0;
    assert.equal((await run(operation)).length, 2);
    assert.equal(
      requests.length,
      3,
      "Without an advertised end, the empty page proves completeness",
    );
    reportEnd = true;
    denySecondPage = true;
    await assert.rejects(run(operation), "A denied later page must not become a partial inventory");
    denySecondPage = false;
  }
});
