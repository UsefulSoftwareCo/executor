import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import { Effect, Exit } from "effect";
import { HttpClient } from "effect/unstable/http";
import { safeHttpClient, safeLookup, type AddressLookup } from "../src/safe-fetch.ts";
import { defaultUrlPolicy, HttpOrigin, httpsOnlyUrlPolicy } from "../src/url-policy.ts";

/** Stand in for DNS: every name in the table resolves to the addresses it is given. */
const resolver =
  (records: Record<string, readonly string[]>): AddressLookup =>
  (hostname, _options, callback) => {
    const addresses = records[hostname];
    if (addresses === undefined)
      return callback(Object.assign(new Error("not found"), { code: "ENOTFOUND" }), []);
    callback(
      null,
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    );
  };

/** Run the hook the way Undici's connector does, and report whether the connection is allowed. */
const resolves = (
  hostname: string,
  records: Record<string, readonly string[]>,
  policy = httpsOnlyUrlPolicy,
) =>
  new Promise<boolean>((resolve) => {
    safeLookup(policy, resolver(records))(hostname, { all: true }, (error) =>
      resolve(error === null),
    );
  });

test("a name resolving to public unicast space connects", async () => {
  assert.equal(await resolves("api.example.com", { "api.example.com": ["93.184.216.34"] }), true);
  assert.equal(await resolves("api.example.com", { "api.example.com": ["2606:4700::1111"] }), true);
  assert.equal(await resolves("api.example.com", { "api.example.com": ["::ffff:8.8.8.8"] }), true);
});

test("a public name resolving into private space is refused", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:169.254.169.254",
  ])
    assert.equal(
      await resolves("rebind.example.com", { "rebind.example.com": [address] }),
      false,
      address,
    );
});

test("one private answer among public answers refuses the whole connection", async () => {
  assert.equal(
    await resolves("mixed.example.com", { "mixed.example.com": ["93.184.216.34", "10.0.0.5"] }),
    false,
  );
});

test("loopback connects only where the deployment opted in", async () => {
  const records = { "dev.example.com": ["127.0.0.1"] };
  assert.equal(await resolves("dev.example.com", records, defaultUrlPolicy), true);
  assert.equal(await resolves("dev.example.com", records, httpsOnlyUrlPolicy), false);
  // The opt-in covers loopback and nothing beside it.
  assert.equal(
    await resolves("lan.example.com", { "lan.example.com": ["192.168.1.1"] }, defaultUrlPolicy),
    false,
  );
});

test("an explicitly allowed origin reaches its own private host", async () => {
  const policy = {
    allowLoopbackHttp: false,
    allowedHttpOrigins: [HttpOrigin.make("http://auth.internal:8080")],
  };
  const records = { "auth.internal": ["10.1.2.3"], "other.internal": ["10.1.2.4"] };
  assert.equal(await resolves("auth.internal", records, policy), true);
  assert.equal(await resolves("other.internal", records, policy), false);
});

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

/**
 * A real listening loopback port reached through a name, so the client itself is proved and
 * not only the hook. A literal address never reaches DNS, and `parseDestination` refuses those.
 */
const start = () =>
  new Promise<string>((resolve) => {
    const server = createServer((_request, response) => {
      response.writeHead(204).end();
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://localhost:${(server.address() as { port: number }).port}/`),
    );
  });

const get = (url: string, policy = httpsOnlyUrlPolicy, resolve?: AddressLookup) =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.flatMap(safeHttpClient(policy, resolve), (client) =>
        HttpClient.withScope(client)
          .get(url)
          .pipe(Effect.map((response) => response.status)),
      ),
    ),
  );

test("the client itself refuses a name resolving to loopback unless opted in", async () => {
  const url = await start();
  assert.ok(Exit.isFailure(await get(url)));
  const allowed = await get(url, defaultUrlPolicy);
  assert.ok(Exit.isSuccess(allowed) && allowed.value === 204);
});

test("a public name pointing at a private address never reaches it", async () => {
  const port = new URL(await start()).port;
  // `parseDestination` cannot see this: the name is public and the URL is well formed.
  const url = `http://records.example.com:${port}/`;
  const records = { "records.example.com": ["127.0.0.1"] };
  assert.ok(Exit.isFailure(await get(url, httpsOnlyUrlPolicy, resolver(records))));
  const allowed = await get(url, defaultUrlPolicy, resolver(records));
  assert.ok(Exit.isSuccess(allowed) && allowed.value === 204);
});
