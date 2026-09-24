/** Production RPC bridge executes webhook lifecycle commands in a real workerd Dynamic Worker. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { Schema } from "effect";
import {
  DeclaredRequirements,
  HostedWebhook,
  HostResponse,
  WebhookResponseData,
} from "apps/contracts";
import { appBridge, appRpcBridge } from "../src/implementation/app-bridge.ts";

const source = `import {defineApp,defineProvider,secrets,object,string} from "apps";
const provider=defineProvider({name:"Synthetic",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export default defineApp({accounts:{service:provider}},async()=>({webhooks:{change:{
 account:"service",config:object({repository:string()}),state:object({registration:string()}),
 async register(ctx,{subscriptionId}){return {registration:subscriptionId}},
 async unregister(){},
 async handle(ctx,{request,secret,state,account}){
   if(request.headers.get("x-test-secret")!==secret)return new Response(null,{status:401});
   return Response.json({state,token:account.fields.token,bytes:Array.from(new Uint8Array(await request.arrayBuffer()))});
 }
}, manual: {
 account:"service",config:object({repository:string()}),state:object({registration:string()}),
 setup:{instructions:"Configure the provider.",signingSecret:"provider"},
 async handle(ctx,{request,secret,state}){return request.headers.get("x-test-secret")===secret?Response.json(state):new Response(null,{status:401})}
}}}));`;

test(
  "register, raw delivery and unregister cross the production Worker RPC boundary",
  { timeout: 30_000 },
  async () => {
    const output = await build({
      stdin: { contents: appBridge([]), resolveDir: process.cwd(), sourcefile: "bridge.ts" },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      conditions: ["workerd"],
      target: "es2022",
      external: ["cloudflare:workers"],
      plugins: [
        {
          name: "fixture",
          setup(builder) {
            builder.onResolve({ filter: /^\.\/index\.ts$/ }, () => ({
              path: "fixture",
              namespace: "fixture",
            }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents: source,
              loader: "ts",
              resolveDir: process.cwd(),
            }));
          },
        },
      ],
    });
    const app = output.outputFiles[0]?.text;
    assert.ok(app);
    const mf = new Miniflare({
      modules: true,
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
      workerLoaders: { LOADER: {} },
      script: `
export default {async fetch(request,env){
 const entry=env.LOADER.get("webhook-fixture",()=>({compatibilityDate:"2026-07-30",compatibilityFlags:["nodejs_compat"],mainModule:"rpc.js",modules:{"rpc.js":${JSON.stringify(appRpcBridge("app.js"))},"app.js":${JSON.stringify(app)}}})).getEntrypoint();
 const call=await entry.start(await request.text(),{},null);
 try{return Response.json(await call.result())}finally{await call.cancel();call[Symbol.dispose]();}
}}`,
    });
    try {
      const invoke = async (command: object, accounts: object = {}) => {
        const response = await mf.dispatchFetch("https://worker.test", {
          method: "POST",
          body: JSON.stringify({ command, accounts }),
        });
        assert.equal(response.status, 200, await response.clone().text());
        const envelope = Schema.decodeUnknownSync(HostResponse)(await response.json());
        assert.ok(envelope.ok, JSON.stringify(envelope));
        return envelope.value;
      };
      const requirements = Schema.decodeUnknownSync(DeclaredRequirements)(
        await invoke({ operation: "requirements" }),
      );
      const provider = requirements.accounts.service;
      assert.ok(provider);
      const accounts = {
        service: {
          id: "acc_fixture",
          provider: provider.definition,
          method: "key",
          fields: { token: "synthetic-token" },
        },
      };
      const common = {
        name: "change",
        subscriptionId: "whk_fixture",
        sourceAccount: "acc_fixture",
        callbackUrl: "https://callback.test/hooks",
        secret: "synthetic-secret",
        config: { repository: "example" },
      };
      const definitions = Schema.decodeUnknownSync(Schema.Array(HostedWebhook))(
        await invoke({ operation: "webhooks" }, accounts),
      );
      assert.equal(
        definitions.find((hook) => hook.name === "manual")?.setup?.signingSecret,
        "provider",
      );
      assert.deepEqual(
        await invoke(
          {
            operation: "webhook-complete",
            ...common,
            name: "manual",
            state: { registration: "operator-provided" },
          },
          accounts,
        ),
        { registration: "operator-provided" },
      );
      const state = await invoke({ operation: "webhook-register", ...common }, accounts);
      assert.deepEqual(state, { registration: "whk_fixture" });
      const raw = new Uint8Array([0, 255, 10, 128]);
      const response = Schema.decodeUnknownSync(WebhookResponseData)(
        await invoke(
          {
            operation: "webhook-handle",
            ...common,
            state,
            request: {
              url: common.callbackUrl,
              method: "POST",
              headers: { "x-test-secret": common.secret },
              body: Buffer.from(raw).toString("base64"),
            },
          },
          accounts,
        ),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(Buffer.from(response.body, "base64").toString()), {
        state,
        token: "synthetic-token",
        bytes: Array.from(raw),
      });
      assert.equal(
        await invoke({ operation: "webhook-unregister", ...common, state }, accounts),
        null,
      );
    } finally {
      await mf.dispose();
    }
  },
);
