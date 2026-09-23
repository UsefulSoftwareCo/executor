import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Manual setup uses real retained app code and persistence, without provider registration callbacks. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Effect, Encoding, FileSystem, Layer, Redacted, Schema } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import { nodeRuntime } from "@executor-js/sdk/node";
import {
  ExecutorApi,
  createExecutor,
  makeExecutorStorage,
  aesGcmCredentials,
  OwnerId,
  SourceFiles,
  WebhookConflict,
  WebhookFailed,
  AccountWebhooksActive,
} from "@executor-js/sdk/core";

for (const signingSecret of ["executor", "provider"] as const) {
  test(`manual ${signingSecret} secrets are private, setup is compare-and-swap, and disable requires removal confirmation`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const storage = yield* makeExecutorStorage({ provider: "postgresql" });
          yield* storage.migrate;
          const executor = yield* createExecutor({
            storage,
            sources: memorySourceStorage(),
            runtime: nodeRuntime({ workDirectory: directory }),
            blobs: memoryBlobStore(),
            credentials: yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto),
            webhookOrigin: "https://callback.example.test",
          });
          const files = Schema.decodeUnknownSync(SourceFiles)([
            {
              path: "index.ts",
              content: `
import {defineApp,defineProvider,secrets,object,string} from "apps";
const provider=defineProvider({name:"Manual",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export default defineApp({accounts:{provider}},async()=>({webhooks:{changed:{
 account:"provider",config:object({}),state:object({webhookId:string()}),
 setup:{instructions:"Paste the callback URL into the provider.",signingSecret:${JSON.stringify(signingSecret)}},
 async handle(ctx,{request,secret,state}) {return request.headers.get("x-signature")===secret ? Response.json(state) : new Response(null,{status:401})}
}}}));`,
            },
          ]);
          const { app } = yield* executor.apps.deploy({
            owner: OwnerId.make("fixture"),
            name: "Manual",
            files,
          });
          const required = app.requirements.accounts.provider;
          assert.ok(required);
          const account = yield* executor.accounts.add({
            owner: app.owner,
            provider: required.provider,
            method: "key",
            label: "Default",
            fields: Redacted.make({ token: "synthetic" }),
          });
          const profile = yield* executor.apps.profiles.create({
            app: app.id,
            owner: app.owner,
            subject: "local",
            idempotencyKey: "test",
            accounts: { provider: account.id },
          });
          const subscription = yield* executor.webhooks.create({
            app: app.id,
            profile: profile.id,
            key: "events",
            name: "changed",
            config: {},
          });
          assert.equal(subscription.status, "setup-required");
          const target = { app: app.id, subscription: subscription.id };
          assert.equal((yield* executor.webhooks.reconcile(target)).status, "setup-required");
          const setup = yield* executor.webhookSetup.read(target);
          assert.equal(setup.step, "configure");
          if (setup.step !== "configure") throw new Error("Missing setup");
          assert.equal(setup.signingSecret.source, signingSecret);
          const secret =
            setup.signingSecret.source === "executor"
              ? Redacted.value(setup.signingSecret.value)
              : "provider-issued-secret";
          assert.ok(!JSON.stringify(subscription).includes(secret));
          assert.ok(!JSON.stringify(setup).includes(secret));
          assert.ok(
            !Object.keys(OpenApi.fromApi(ExecutorApi).paths).some((path) =>
              path.startsWith("/webhook-setup"),
            ),
          );
          const input = {
            ...target,
            revision: setup.revision,
            state: Redacted.make({ webhookId: "remote-hook" }),
            ...(signingSecret === "provider" ? { secret: Redacted.make(secret) } : {}),
          };
          assert.ok(
            Schema.is(WebhookConflict)(
              yield* executor.webhookSetup
                .complete({ ...input, revision: "stale" })
                .pipe(Effect.flip),
            ),
          );
          assert.ok(
            Schema.is(WebhookFailed)(
              yield* executor.webhookSetup
                .complete({ ...input, state: Redacted.make({}) })
                .pipe(Effect.flip),
            ),
          );
          assert.equal((yield* executor.webhooks.get(target)).status, "setup-required");
          assert.equal((yield* executor.webhookSetup.complete(input)).status, "active");
          assert.equal((yield* executor.webhookSetup.read(target)).step, "done");
          const response = yield* executor.webhooks.deliver({
            ...target,
            request: {
              url: subscription.callbackUrl,
              method: "POST",
              headers: { "x-signature": secret },
              body: "",
            },
          });
          assert.equal(response.status, 200);
          assert.equal(
            new TextDecoder().decode(
              yield* Effect.fromResult(Encoding.decodeBase64(response.body)),
            ),
            JSON.stringify({ webhookId: "remote-hook" }),
          );
          const disabled = yield* executor.webhooks.remove(target);
          assert.equal(disabled.status, "disabled");
          assert.equal((yield* executor.webhookSetup.read(target)).step, "remove");
          assert.ok(
            Schema.is(WebhookFailed)(
              yield* executor.webhooks
                .deliver({
                  ...target,
                  request: { url: subscription.callbackUrl, method: "POST", headers: {}, body: "" },
                })
                .pipe(Effect.flip),
            ),
          );
          assert.ok(
            Schema.is(AccountWebhooksActive)(
              yield* executor.accounts.remove({ account: account.id }).pipe(Effect.flip),
            ),
          );
          assert.equal((yield* executor.webhooks.confirmRemoval(target)).status, "stopped");
          assert.equal((yield* executor.webhooks.confirmRemoval(target)).status, "stopped");
          yield* executor.accounts.remove({ account: account.id });
          yield* executor.apps.remove({ app: app.id });
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pgliteLayer()))),
    ));
}
