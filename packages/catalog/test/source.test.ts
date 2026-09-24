import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type Server } from "node:http";
import { Effect, Exit } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { safeHttpClient, type AddressLookup } from "@executor-js/utils/safe-fetch";
import {
  defaultUrlPolicy,
  httpsOnlyUrlPolicy,
  type UrlPolicy,
} from "@executor-js/utils/url-policy";
import { catalogSource, readApiDocument } from "../src/implementation/source.ts";

const spec = JSON.stringify({ openapi: "3.1.0", paths: {} });

/** One loopback origin standing in for a documentation host the operator trusts. */
const listen = (handler: Parameters<typeof createServer>[1]) =>
  new Promise<{ server: Server; origin: string }>((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      }),
    );
  });

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

const start = async (handler: Parameters<typeof createServer>[1]) => {
  const started = await listen(handler);
  servers.push(started.server);
  return started.origin;
};

/** Read through the same connect-time client a Node host uses, so both rules are exercised. */
const read = (url: string, policy: UrlPolicy, resolve?: AddressLookup) =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.flatMap(safeHttpClient(policy, resolve), (client) =>
        readApiDocument(url, { policy, client }),
      ),
    ),
  );

test("a loopback definition loads when the deployment allows loopback", async () => {
  const origin = await start((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(spec);
  });
  assert.ok(Exit.isSuccess(await read(`${origin}/openapi.json`, defaultUrlPolicy)));
});

test("the same definition is refused when the deployment is public-only", async () => {
  const origin = await start((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(spec);
  });
  assert.ok(Exit.isFailure(await read(`${origin}/openapi.json`, httpsOnlyUrlPolicy)));
});

test("a redirect into link-local space is not followed", async () => {
  const origin = await start((_request, response) => {
    response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    response.end();
  });
  assert.ok(Exit.isFailure(await read(`${origin}/openapi.json`, defaultUrlPolicy)));
});

test("a redirect within the allowed destination is followed", async () => {
  let redirected = false;
  const origin = await start((request, response) => {
    if (!redirected) {
      redirected = true;
      response.writeHead(302, { location: "/v2/openapi.json" });
      response.end();
      return;
    }
    assert.equal(request.url, "/v2/openapi.json");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(spec);
  });
  assert.ok(Exit.isSuccess(await read(`${origin}/openapi.json`, defaultUrlPolicy)));
});

test("a redirect hop is judged by the address its name resolves to", async () => {
  // Both hops pass the URL rule; only the address behind the second hop's name differs. The
  // URL rule cannot see that difference, so the connect-time check is what separates the runs.
  const target = await start((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(spec);
  });
  const port = new URL(target).port;
  const origin = await start((_request, response) => {
    response.writeHead(302, { location: `http://records.localhost:${port}/openapi.json` });
    response.end();
  });
  const resolving =
    (address: string): AddressLookup =>
    (_hostname, _options, callback) =>
      callback(null, [{ address, family: 4 }]);
  assert.ok(
    Exit.isSuccess(await read(`${origin}/openapi.json`, defaultUrlPolicy, resolving("127.0.0.1"))),
  );
  assert.ok(
    Exit.isFailure(await read(`${origin}/openapi.json`, defaultUrlPolicy, resolving("10.0.0.5"))),
  );
});

test("a catalog entry reads its definition from connectUrl, not its feed names", async () => {
  const requested: string[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requested.push(request.url);
      return HttpClientResponse.fromWeb(request, new Response(spec, { status: 200 }));
    }),
  );
  const exit = await Effect.runPromiseExit(
    catalogSource(client).document({
      id: "curated/example-com-openapi",
      kind: "openapi",
      name: "Example",
      description: "",
      domain: "example.com",
      feeds: ["curated"],
      connectUrl: "https://openapi.example.com",
    }),
  );
  assert.ok(Exit.isSuccess(exit));
  assert.deepEqual(requested, ["https://openapi.example.com/"]);
});
