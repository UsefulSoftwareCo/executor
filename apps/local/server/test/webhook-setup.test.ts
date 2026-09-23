import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Real local pairing and HTTP contracts keep secret setup separate from management keys. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import { nodeRuntime } from "@executor-js/sdk/node";
import {
  createExecutor,
  makeExecutorStorage,
  aesGcmCredentials,
  OwnerId,
  SourceFiles,
  WebhookSetupView,
} from "@executor-js/sdk/core";
import { ServerConfig } from "../src/contracts/config.ts";
import { LocalWebhookSetupApi } from "../src/contracts/webhook-setup.ts";
import { localWebhookSetupHandlers } from "../src/implementation/webhook-setup.ts";
import { makeLocalAuth, sessionCookie } from "../src/implementation/auth.ts";

test("API keys get links, while paired cookies and same-origin writes control setup", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const config = Schema.decodeUnknownSync(ServerConfig)({
          directory,
          port: 4312,
          apiKey: "synthetic-webhook-key-00000000000000",
          encryptionKey: "ab".repeat(32),
        });
        const storage = yield* makeExecutorStorage({ provider: "postgresql" });
        yield* storage.migrate;
        const executor = yield* createExecutor({
          storage,
          sources: memorySourceStorage(),
          blobs: memoryBlobStore(),
          runtime: nodeRuntime({ workDirectory: directory + "/builds" }),
          credentials: yield* aesGcmCredentials(config.encryptionKey, crypto),
          webhookOrigin: "https://provider-callback.example.test",
        });
        const auth = yield* makeLocalAuth(crypto, directory);
        const { app } = yield* executor.apps.deploy({
          owner: OwnerId.make("local"),
          name: "Manual",
          files: Schema.decodeUnknownSync(SourceFiles)([
            {
              path: "index.ts",
              content: `import {defineApp,defineProvider,secrets,object,string} from "apps";
const service=defineProvider({name:"Manual",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export default defineApp({accounts:{service}},async()=>({webhooks:{events:{account:"service",config:object({}),state:object({id:string()}),setup:{instructions:"Paste the callback URL.",signingSecret:"executor"},async handle(){return new Response(null,{status:204})}}}}));`,
            },
          ]),
        });
        const requirement = app.requirements.accounts.service;
        assert.ok(requirement);
        const account = yield* executor.accounts.add({
          owner: app.owner,
          provider: requirement.provider,
          method: "key",
          label: "Default",
          fields: Redacted.make({ token: "synthetic" }),
        });
        const profile = yield* executor.apps.profiles.create({
          app: app.id,
          owner: app.owner,
          subject: "local",
          idempotencyKey: "test",
          accounts: { service: account.id },
        });
        const subscription = yield* executor.webhooks.create({
          app: app.id,
          profile: profile.id,
          key: "events",
          name: "events",
          config: {},
        });
        const web = HttpRouter.toWebHandler(
          HttpApiBuilder.layer(LocalWebhookSetupApi).pipe(
            Layer.provide(localWebhookSetupHandlers(executor, config, auth)),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));
        const path = `/webhook-setup/api/${app.id}/${subscription.id}`;
        const base = "http://127.0.0.1:4312";
        const request = (path: string, headers: Record<string, string> = {}, body?: object) =>
          Effect.promise(() =>
            web.handler(
              new Request(base + path, {
                method: body === undefined ? "GET" : "POST",
                headers: {
                  host: "127.0.0.1:4312",
                  ...headers,
                  ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              }),
            ),
          );
        const bearer = { authorization: `Bearer ${Redacted.value(config.apiKey)}` };
        assert.equal((yield* request(path)).status, 401);
        assert.equal((yield* request(path, bearer)).status, 401);
        const link = yield* request(path + "/link", bearer);
        assert.equal(link.status, 200);
        assert.deepEqual(yield* Effect.promise(() => link.json()), {
          url: `${base}/webhooks/${app.id}/${subscription.id}`,
        });
        const issued = yield* auth.issue();
        const session = yield* auth.exchange(issued.token);
        const cookie = { cookie: `${sessionCookie(config.port)}=${Redacted.value(session)}` };
        const read = yield* request(path, cookie);
        assert.equal(read.status, 200);
        assert.equal(read.headers.get("cache-control"), "no-store");
        const setup = yield* Effect.promise(() => read.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(WebhookSetupView))),
        );
        assert.equal(setup.step, "configure");
        if (setup.step !== "configure") throw new Error("No setup");
        const body = { revision: setup.revision, state: { id: "remote-id" } };
        assert.equal((yield* request(path, cookie, body)).status, 403);
        assert.equal(
          (yield* request(path, { ...cookie, origin: "https://other.example" }, body)).status,
          403,
        );
        assert.equal(
          (yield* request(path, { ...cookie, ...bearer, origin: base }, body)).status,
          401,
        );
        assert.equal((yield* request(path, { ...cookie, origin: base }, body)).status, 200);
        const done = yield* request(path, cookie);
        assert.equal(done.status, 200);
        const value: unknown = yield* Effect.promise(() => done.json());
        assert.equal(
          Schema.decodeUnknownSync(Schema.Struct({ step: Schema.String }))(value).step,
          "done",
        );
        if (setup.signingSecret.source === "executor")
          assert.ok(!JSON.stringify(value).includes(Redacted.value(setup.signingSecret.value)));
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pgliteLayer()))),
  ));
