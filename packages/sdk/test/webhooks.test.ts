import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Real Node app builds, SQL persistence and HTTP callback transport against a synthetic provider. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Deferred, Effect, Fiber, FileSystem, Layer, Redacted, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import { nodeRuntime } from "@executor-js/sdk/node";
import {
  ExecutorApi,
  executorHandlers,
  createExecutor,
  makeExecutorStorage,
  aesGcmCredentials,
  OwnerId,
  SourceFiles,
  AppWebhooksActive,
  AccountWebhooksActive,
  WebhookConflict,
  WebhookFailed,
  webhookCallback,
} from "@executor-js/sdk/core";

const Registration = Schema.Struct({
  subscriptionId: Schema.String,
  secret: Schema.String,
  callbackUrl: Schema.String,
  token: Schema.String,
  loseResponse: Schema.Boolean,
});
const source = (url: string, version = 1) =>
  Schema.decodeUnknownSync(SourceFiles)([
    {
      path: "index.ts",
      content: `
import {defineApp,defineProvider,secrets,object,string,boolean} from "apps";
const provider=defineProvider({name:"Webhook fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export default defineApp({accounts:{source:provider.many(),other:provider}},async()=>({webhooks:{changed:{
 account:"source",config:object({loseResponse:boolean()}),state:object({registration:string()}),
 async register(ctx,{subscriptionId,account,callbackUrl,secret,config}){
  const response=await ctx.fetch(${JSON.stringify(url)}+"/register",{method:"POST",body:JSON.stringify({subscriptionId,callbackUrl,secret,token:account.fields.token,...config})});
  if(!response.ok)throw new Error("Private provider failure");return response.json();
 },
 async unregister(ctx,{subscriptionId}){const response=await ctx.fetch(${JSON.stringify(url)}+"/unregister",{method:"POST",body:JSON.stringify({subscriptionId})});if(!response.ok)throw new Error("Private cleanup failure")},
 async handle(ctx,{request,secret,state,account}){
  const bytes=await request.arrayBuffer();const signature=request.headers.get("x-signature");
  if(!signature||!/^[0-9a-f]{64}$/.test(signature))return new Response(null,{status:401});
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
  const digest=Uint8Array.from(signature.match(/../g),x=>parseInt(x,16));
  if(!await crypto.subtle.verify("HMAC",key,digest,bytes))return new Response(null,{status:401});
  if(state===null)return new Response("challenge-ok");
  return Response.json({version:${version},source:account.fields.token,other:ctx.accounts.other.fields.token,cookie:request.headers.get("cookie"),bytes:Array.from(new Uint8Array(bytes))},{headers:{"set-cookie":"bad=1","location":"https://evil.invalid"}});
 }
}}}));`,
    },
  ]);

async function provider() {
  const registrations = new Map<string, typeof Registration.Type>();
  let attempts = 0;
  let cleanupFails = false;
  let paused: { entered: Deferred.Deferred<void>; released: Deferred.Deferred<void> } | undefined;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url === "/register") {
        attempts++;
        const parsed = Schema.decodeUnknownSync(Registration)(input);
        const existing = registrations.has(parsed.subscriptionId);
        registrations.set(parsed.subscriptionId, parsed);
        if (parsed.loseResponse && !existing) {
          response.writeHead(503).end();
          return;
        }
        if (paused !== undefined) {
          await Effect.runPromise(Deferred.succeed(paused.entered, undefined));
          await Effect.runPromise(Deferred.await(paused.released));
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ registration: parsed.subscriptionId }));
      } else {
        const parsed = Schema.decodeUnknownSync(Schema.Struct({ subscriptionId: Schema.String }))(
          input,
        );
        if (cleanupFails) {
          response.writeHead(503).end();
          return;
        }
        registrations.delete(parsed.subscriptionId);
        response.writeHead(204).end();
      }
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    registrations,
    attempts: () => attempts,
    pauseRegistration: () => {
      const entered = Deferred.makeUnsafe<void>();
      const released = Deferred.makeUnsafe<void>();
      paused = { entered, released };
      return {
        entered: Effect.runPromise(Deferred.await(entered)),
        release: () => {
          paused = undefined;
          Effect.runSync(Deferred.succeed(released, undefined));
        },
      };
    },
    failCleanup: (value: boolean) => {
      cleanupFails = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
const sign = async (secret: string, body: Uint8Array) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Buffer.from(await crypto.subtle.sign("HMAC", key, Uint8Array.from(body))).toString("hex");
};

test(
  "webhooks retain code/accounts, resolve fresh credentials, recover failures and stop before cleanup",
  { timeout: 60_000 },
  async () => {
    const remote = await provider();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const directory = yield* fs.makeTempDirectoryScoped();
            const storage = yield* makeExecutorStorage({ provider: "postgresql" });
            yield* storage.migrate;
            const options = {
              storage,
              sources: memorySourceStorage(),
              blobs: memoryBlobStore(),
              runtime: nodeRuntime({ workDirectory: directory }),
              credentials: yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto),
              webhookOrigin: "https://hooks.example.test",
            };
            const executor = yield* createExecutor(options);
            const owner = OwnerId.make("synthetic-owner");
            const { app } = yield* executor.apps.deploy({
              owner,
              name: "Hooks",
              files: source(remote.url),
            });
            const requirement = app.requirements.accounts.source;
            assert.ok(requirement);
            const addAccount = (token: string) =>
              executor.accounts.add({
                owner,
                provider: requirement.provider,
                method: "key",
                fields: Redacted.make({ token }),
                label: token,
              });
            const first = yield* addAccount("first");
            const second = yield* addAccount("second");
            const other = yield* addAccount("other");
            yield* executor.apps.update({
              app: app.id,
              accounts: { source: [first.id, second.id], other: other.id },
            });
            assert.equal(
              (yield* executor.webhooks.definitions({ app: app.id }))[0]?.account,
              "source",
            );
            assert.equal(remote.attempts(), 0);
            const invalid = yield* executor.webhooks
              .create({
                app: app.id,
                name: "changed",
                key: "invalid",
                sourceAccount: first.id,
                config: {},
              })
              .pipe(Effect.flip);
            assert.ok(Schema.is(WebhookFailed)(invalid));
            assert.equal((yield* executor.webhooks.list({ app: app.id })).length, 0);
            const subscription = yield* executor.webhooks.create({
              app: app.id,
              name: "changed",
              key: "primary",
              sourceAccount: first.id,
              config: { loseResponse: true },
            });
            assert.equal(subscription.status, "pending");
            assert.equal(subscription.failure, "register");
            assert.equal(remote.registrations.size, 1);
            const registration = remote.registrations.get(subscription.id);
            assert.ok(registration);
            const stored = yield* storage
              .orm("3.0.0")
              .findFirst("webhooks", { where: (b) => b("id", "=", subscription.id) });
            assert.ok(stored);
            assert.ok(!new TextDecoder().decode(stored.encrypted).includes(registration.secret));
            assert.ok(!JSON.stringify(subscription).includes(registration.secret));
            const target = { app: app.id, subscription: subscription.id };
            const web = HttpRouter.toWebHandler(
              Layer.merge(
                HttpRouter.add(
                  "*",
                  "/api/webhooks/:appId/:subscriptionId",
                  webhookCallback(executor),
                ),
                HttpApiBuilder.layer(ExecutorApi).pipe(Layer.provide(executorHandlers(executor))),
              ).pipe(Layer.provide(HttpServer.layerServices)),
              { disableLogger: true },
            );
            yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));
            const inventory = yield* Effect.promise(() =>
              web.handler(new Request(`https://hooks.example.test/v1/apps/${app.id}/webhooks`)),
            );
            assert.equal(
              inventory.status,
              200,
              yield* Effect.promise(() => inventory.clone().text()),
            );
            const inventoryBody: unknown = yield* Effect.promise(() => inventory.json());
            const records = Schema.decodeUnknownSync(
              Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
            )(inventoryBody);
            assert.equal(records[0]?.id, subscription.id);
            const body = new Uint8Array([255, 0, 1, 10, 13, 128]);
            const signature = yield* Effect.promise(() => sign(registration.secret, body));
            const deliver = (sig = signature) =>
              Effect.promise(() =>
                web.handler(
                  new Request(registration.callbackUrl, {
                    method: "POST",
                    headers: { "x-signature": sig, cookie: "dashboard=private" },
                    body,
                  }),
                ),
              );
            const foreign = yield* executor.apps.copy({
              from: app.id,
              owner: OwnerId.make("other-owner"),
              name: app.name,
            });
            assert.equal(foreign.slug, app.slug);
            assert.notEqual(foreign.id, app.id);
            const wrongApp = new URL(registration.callbackUrl);
            wrongApp.pathname = `/api/webhooks/${foreign.id}/${subscription.id}`;
            const mismatched = yield* Effect.promise(() =>
              web.handler(
                new Request(wrongApp, {
                  method: "POST",
                  headers: { "x-signature": signature },
                  body,
                }),
              ),
            );
            assert.equal(mismatched.status, 404);
            const slugInsteadOfId = new URL(registration.callbackUrl);
            slugInsteadOfId.pathname = `/api/webhooks/${app.slug}/${subscription.id}`;
            const slugRejected = yield* Effect.promise(() =>
              web.handler(
                new Request(slugInsteadOfId, {
                  method: "POST",
                  headers: { "x-signature": signature },
                  body,
                }),
              ),
            );
            assert.equal(slugRejected.status, 400);
            const challenge = yield* deliver();
            assert.equal(yield* Effect.promise(() => challenge.text()), "challenge-ok");
            // Reconstructing the SDK leaves durable intent and provider identity intact.
            const restarted = yield* createExecutor(options);
            assert.equal((yield* restarted.webhooks.reconcile(target)).status, "active");
            assert.equal(remote.registrations.size, 1);
            assert.equal(
              (yield* executor.webhooks.create({
                app: app.id,
                name: "changed",
                key: "primary",
                sourceAccount: first.id,
                config: { loseResponse: true },
              })).id,
              subscription.id,
            );
            assert.equal(remote.attempts(), 2);
            assert.ok(
              Schema.is(WebhookConflict)(
                yield* executor.webhooks
                  .create({
                    app: app.id,
                    name: "changed",
                    key: "primary",
                    sourceAccount: second.id,
                    config: { loseResponse: false },
                  })
                  .pipe(Effect.flip),
              ),
            );
            yield* executor.apps.update({
              app: app.id,
              accounts: { source: [second.id], other: second.id },
            });
            yield* executor.accounts.replaceCredentials({
              account: first.id,
              fields: Redacted.make({ token: "refreshed-first" }),
            });
            yield* executor.apps.deploy({
              owner,
              app: app.id,
              files: source(remote.url, 2),
            });
            const response = yield* deliver();
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("set-cookie"), null);
            assert.equal(response.headers.get("location"), null);
            assert.match(response.headers.get("content-security-policy") ?? "", /sandbox/);
            assert.deepEqual(yield* Effect.promise(() => response.json()), {
              version: 1,
              source: "refreshed-first",
              other: "other",
              cookie: null,
              bytes: Array.from(body),
            });
            assert.equal((yield* deliver("0".repeat(64))).status, 401);
            assert.ok(
              Schema.is(AppWebhooksActive)(
                yield* executor.apps.remove({ app: app.id }).pipe(Effect.flip),
              ),
            );
            assert.ok(
              Schema.is(AccountWebhooksActive)(
                yield* executor.accounts.remove({ account: first.id }).pipe(Effect.flip),
              ),
            );
            assert.ok(
              Schema.is(AccountWebhooksActive)(
                yield* executor.accounts.remove({ account: other.id }).pipe(Effect.flip),
              ),
            );
            remote.failCleanup(true);
            const failed = yield* executor.webhooks.remove(target);
            assert.equal(failed.status, "stopping");
            assert.equal(failed.failure, "unregister");
            assert.equal((yield* deliver()).status, 410);
            remote.failCleanup(false);
            assert.equal((yield* executor.webhooks.reconcile(target)).status, "stopped");
            assert.equal(remote.registrations.size, 0);
            const paused = remote.pauseRegistration();
            const pending = yield* executor.webhooks
              .create({
                app: app.id,
                key: "parallel",
                name: "changed",
                sourceAccount: second.id,
                config: { loseResponse: false },
              })
              .pipe(Effect.forkChild);
            yield* Effect.promise(() => paused.entered);
            try {
              const parallel = (yield* executor.webhooks.list({ app: app.id })).find(
                (row) => row.key === "parallel",
              );
              assert.ok(parallel);
              const conflict = yield* executor.webhooks
                .reconcile({ app: app.id, subscription: parallel.id })
                .pipe(Effect.flip);
              assert.ok(Schema.is(WebhookConflict)(conflict));
            } finally {
              paused.release();
            }
            const parallel = yield* Fiber.join(pending);
            assert.equal(parallel.status, "active");
            yield* executor.webhooks.remove({ app: app.id, subscription: parallel.id });
            yield* executor.accounts.remove({ account: first.id });
            yield* executor.apps.remove({ app: app.id });
            assert.equal((yield* deliver()).status, 404);
          }),
        ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pgliteLayer()))),
      );
    } finally {
      await remote.close();
    }
  },
);
