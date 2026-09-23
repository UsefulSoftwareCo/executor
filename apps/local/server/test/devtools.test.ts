/** The dev shortcut pairs through real auth; ordinary local servers have no shortcut. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Schema } from "effect";
import { ServerConfig } from "../src/contracts/config.ts";
import { startLocalServer } from "../src/node.ts";
import { localDevtools } from "../src/implementation/devtools.ts";

test(
  "local dev pairing creates a normal session and rejects cross-site requests",
  { timeout: 30_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const settings = Schema.decodeUnknownSync(ServerConfig)({
            directory,
            port: 0,
            apiKey: "synthetic-devtools-api-key-1234567890",
            encryptionKey: "cd".repeat(32),
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* startLocalServer(settings);
              const response = yield* Effect.promise(() => fetch(`${server.url}/api/devtools`));
              assert.equal(response.status, 404);
              yield* Effect.promise(() => response.arrayBuffer());
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* startLocalServer(settings, undefined, {
                devtools: localDevtools,
              });
              yield* Effect.promise(async () => {
                const state = await fetch(`${server.url}/api/devtools`);
                assert.deepEqual(await state.json(), {
                  kind: "pairing",
                  host: "local",
                  paired: false,
                });
                for (const headers of [{ origin: "https://example.com" }, {}]) {
                  const denied = await fetch(`${server.url}/api/devtools/pair`, {
                    method: "POST",
                    headers,
                  });
                  assert.equal(denied.status, 403);
                  assert.equal(denied.headers.get("set-cookie"), null);
                  await denied.arrayBuffer();
                }
                // Native HTTP preserves a forged Host header; fetch normalizes it to the URL host.
                const wrongHost = await new Promise<number>((resolve, reject) => {
                  const req = request(
                    `${server.url}/api/devtools/pair`,
                    {
                      method: "POST",
                      headers: { origin: server.url, host: "rebinding.example.com" },
                    },
                    (response) => {
                      response.resume();
                      response.on("end", () => resolve(response.statusCode ?? 0));
                    },
                  );
                  req.on("error", reject);
                  req.end();
                });
                assert.equal(wrongHost, 403);
                const paired = await fetch(`${server.url}/api/devtools/pair`, {
                  method: "POST",
                  headers: { origin: server.url },
                });
                assert.equal(paired.status, 200);
                assert.deepEqual(await paired.json(), { status: true });
                const cookie = Schema.decodeUnknownSync(Schema.NonEmptyString)(
                  paired.headers.get("set-cookie"),
                );
                assert.match(cookie, /HttpOnly/);
                const headers = {
                  cookie: Schema.decodeUnknownSync(Schema.NonEmptyString)(cookie.split(";")[0]),
                  origin: server.url,
                };
                const after = await fetch(`${server.url}/api/devtools`, { headers });
                assert.deepEqual(await after.json(), {
                  kind: "pairing",
                  host: "local",
                  paired: true,
                });
                const inventory = await fetch(`${server.url}/dashboard/api/overview`, { headers });
                assert.equal(inventory.status, 200);
                await inventory.arrayBuffer();
              });
            }),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    ),
);
