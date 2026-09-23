/** The production callback and bridge run in actual workerd isolates, with no replay of the tool. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { ElicitationFailed, HostResponse } from "apps/contracts";
import { Schema } from "effect";
import { appBridge, appRpcBridge } from "../src/implementation/app-bridge.ts";

const source = `import { query, mutation, defineApp, object } from "apps";
let starts = 0;
export default defineApp({ accounts: {} }, async (appContext) => ({  mutations: { ask: mutation({ description: "Ask",
            input: object({}) }, async (operationContext, _input) => {
            const { elicit } = { ...appContext, ...operationContext };
            const marker = ++starts;
            const first = await elicit({ mode: "form", message: "First", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } });
            if (first.action !== "accept")
                return { marker, action: first.action };
            const second = await elicit({ mode: "form", message: "Second", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } });
            return { marker, first: first.content.name, second };
        }) } }));
`;

const invokeSource = `async function invokeRuntime(stub, body, headers, elicitation) {
  const call = await stub.start(body, headers, elicitation);
  try { return await call.result(); } finally { await call.cancel(); call[Symbol.dispose](); }
}`;

async function bundle(contents: string, fixture: boolean | string = false) {
  const output = await build({
    stdin: {
      contents: invokeSource + "\n" + contents,
      resolveDir: process.cwd(),
      sourcefile: "entry.ts",
    },
    bundle: true,
    write: false,
    platform: "browser",
    conditions: ["workerd"],
    format: "esm",
    target: "es2022",
    external: ["cloudflare:workers"],
    ...(fixture
      ? {
          plugins: [
            {
              name: "synthetic-app",
              setup(builder) {
                builder.onResolve({ filter: /^\.\/index\.ts$/ }, () => ({
                  path: "fixture",
                  namespace: "fixture",
                }));
                builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
                  contents: typeof fixture === "string" ? fixture : source,
                  loader: "ts",
                  resolveDir: process.cwd(),
                }));
              },
            },
          ],
        }
      : {}),
  });
  const code = output.outputFiles[0]?.text;
  assert.ok(code);
  return code;
}

test(
  "Dynamic Worker returns user input into the same live invocation across two callbacks",
  { timeout: 30_000 },
  async () => {
    const app = await bundle(appBridge, true);
    const rpc = appRpcBridge("app.js");
    const parent = await bundle(`
    import {Effect,Schema} from "effect";
    import {invocationElicitation,AppRpcEntrypoint} from "./src/implementation/elicitation.ts";
    export default { async fetch(request,env) {
      const {action="accept",invalid=false}=await request.json();let prompts=0;
      const controller=new AbortController();
      const handler=()=>Effect.gen(function*(){prompts++;yield* Effect.sleep("20 millis");return action==="accept"?{action,content:{name:invalid?42:"answer-"+prompts}}:{action};});
      try {
        const worker=env.LOADER.get(null,()=>({compatibilityDate:"2026-07-30",compatibilityFlags:["nodejs_compat"],mainModule:"rpc.js",modules:{"rpc.js":${JSON.stringify(rpc)},"app.js":${JSON.stringify(app)}}}));
        const stub=Schema.decodeUnknownSync(AppRpcEntrypoint)(worker.getEntrypoint());
        const body=await invokeRuntime(stub,JSON.stringify({command:{operation:"call",tool:"mutations.ask",input:{}},accounts:{}}),{},invocationElicitation(handler,controller.signal));
        return Response.json({body,prompts});
      } finally {controller.abort()}
    }};`);
    const mf = new Miniflare({
      modules: true,
      script: parent,
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
      workerLoaders: { LOADER: {} },
    });
    try {
      const call = async (input: object) => {
        const response = await mf.dispatchFetch("http://worker/", {
          method: "POST",
          body: JSON.stringify(input),
        });
        assert.equal(response.status, 200, await response.clone().text());
        return Schema.decodeUnknownSync(
          Schema.Struct({ body: HostResponse, prompts: Schema.Number }),
        )(await response.json());
      };
      const accepted = await call({});
      assert.equal(accepted.prompts, 2);
      assert.deepEqual(accepted.body, {
        ok: true,
        value: {
          marker: 1,
          first: "answer-1",
          second: { action: "accept", content: { name: "answer-2" } },
        },
      });
      for (const action of ["decline", "cancel"]) {
        const declined = await call({ action });
        assert.equal(declined.prompts, 1);
        assert.deepEqual(declined.body, { ok: true, value: { marker: 1, action } });
      }
      const invalid = await call({ invalid: true });
      assert.equal(invalid.prompts, 1);
      if (invalid.body.ok || !Schema.is(ElicitationFailed)(invalid.body.error))
        throw new Error("Invalid content was not rejected");
      assert.equal(invalid.body.error.reason, "invalid-response");
    } finally {
      await mf.dispose();
    }
  },
);

test(
  "runtime RPC wrapper keeps retained fetch bridges usable without an elicitation callback",
  { timeout: 20_000 },
  async () => {
    const mf = new Miniflare({
      modules: true,
      compatibilityDate: "2026-07-30",
      workerLoaders: { LOADER: {} },
      script: `${invokeSource}

    export default {async fetch(request,env) {
      const worker=env.LOADER.get(null,()=>({compatibilityDate:"2026-07-30",mainModule:"rpc.js",modules:{
        "rpc.js":${JSON.stringify(appRpcBridge("old.js"))},
        "old.js":'export default {async fetch(request){const body=await request.json();return Response.json({ok:true,value:body.command.input});}}'
      }}));return Response.json(await invokeRuntime(worker.getEntrypoint(),JSON.stringify({command:{operation:"call",tool:"mutations.old",input:{old:true}},accounts:{}}),{},null));
    }};`,
    });
    try {
      const response = await mf.dispatchFetch("http://worker/");
      assert.deepEqual(await response.json(), { ok: true, value: { old: true } });
    } finally {
      await mf.dispose();
    }
  },
);

test(
  "a Durable Object resumes the same Dynamic Worker invocation across separate requests",
  { timeout: 30_000 },
  async () => {
    const app = await bundle(appBridge, true);
    const rpc = appRpcBridge("app.js");
    const parent = await bundle(`
    import {DurableObject} from "cloudflare:workers";
    import {Effect,Scope,Exit,Schema} from "effect";
    import {makeExecutions,defaultMcpLimits,ResumeInput} from "@executor-js/mcp";
    import {AppId,DeploymentId,ToolName} from "@executor-js/sdk/core";
    import {HostResponse} from "apps/contracts";
    import {invocationElicitation,AppRpcEntrypoint} from "./src/implementation/elicitation.ts";
    export class Session extends DurableObject {
      constructor(ctx,env) {super(ctx,env);this.engine=Effect.runPromise(Effect.gen(function*(){const scope=yield* Scope.make(); const engine=yield* makeExecutions({...defaultMcpLimits,timeoutMs:500}).pipe(Scope.provide(scope));return {scope,engine};}));this.started=0;this.released=0;}
      async fetch(request) {
        const {scope,engine}=await this.engine;
        const app=AppId.make("app_fixture"),deployment=DeploymentId.make("dpl_fixture");
        const backend={
          listApps:()=>Effect.succeed([{id:app,slug:"fixture",name:"Live input"}]),
          listTools:()=>Effect.succeed({deployment,items:[{app,deployment,name:ToolName.make("mutations.ask"),description:"Ask",inputSchema:{type:"object",properties:{}}}]}),
          authorizeElicitation:()=>Effect.void,
          resumeInvocation:()=>Effect.die("No policy in this fixture"),
          callTool:(_input,options)=>Effect.gen({self:this},function*(){
            this.started++;
            yield* Effect.addFinalizer(()=>Effect.sync(()=>{this.released++}));
            const body=yield* Effect.tryPromise({try:signal=>{
              const worker=this.env.LOADER.get(null,()=>({compatibilityDate:"2026-07-30",compatibilityFlags:["nodejs_compat"],mainModule:"rpc.js",modules:{"rpc.js":${JSON.stringify(rpc)},"app.js":${JSON.stringify(app)}}}));
              const stub=Schema.decodeUnknownSync(AppRpcEntrypoint)(worker.getEntrypoint());
              return invokeRuntime(stub,JSON.stringify({command:{operation:"call",tool:"mutations.ask",input:{}},accounts:{}}),{},invocationElicitation(options.elicitation,signal));
            },catch:()=>new Error("Dynamic invocation failed")});
            const reply=yield* Schema.decodeUnknownEffect(HostResponse)(body);
            if(!reply.ok)return yield* Effect.fail(reply.error);
            return {status:"completed",value:reply.value};
          })
        };
        const data=await request.json();
        const operation=data.operation==="execute"?engine.execute("caller",backend,'return await tools.fixture.mutations.ask({})'):
          data.operation==="resume"?engine.resume("caller",backend,Schema.decodeUnknownSync(ResumeInput)(data.input)):
          data.operation==="browser-get"?engine.browserView("caller",data.requestId):
          data.operation==="browser-answer"?engine.answerInBrowser("caller",data.requestId,data.response):
          data.operation==="browser-resume"?Effect.gen(function*(){const response=yield* engine.browserAnswer("caller",data.requestId,100);if(response===undefined)throw new Error("Missing browser answer");return yield* engine.resume("caller",backend,{requestId:data.requestId,response});}):
          data.operation==="discard"?engine.discard("caller",data.requestId):Scope.close(scope,Exit.void);
        const result=await Effect.runPromise(Effect.scoped(operation));
        return Response.json({result,started:this.started,released:this.released});
      }
    }
    export default {fetch(request,env){return env.SESSION.get(env.SESSION.idFromName("test")).fetch(request)}};
  `);
    const mf = new Miniflare({
      modules: true,
      script: parent,
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
      workerLoaders: { LOADER: {} },
      durableObjects: { SESSION: "Session" },
    });
    const { McpExecutionResult } = await import("@executor-js/mcp");
    const Envelope = Schema.Struct({
      result: McpExecutionResult,
      started: Schema.Number,
      released: Schema.Number,
    });
    const send = async (data: object) => {
      const response = await mf.dispatchFetch("http://worker/", {
        method: "POST",
        body: JSON.stringify(data),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    try {
      const first = Schema.decodeUnknownSync(Envelope)(await send({ operation: "execute" }));
      assert.equal(first.started, 1);
      assert.equal(first.released, 0);
      assert.ok(first.result.status === "input-required", JSON.stringify(first));
      await new Promise((resolve) => setTimeout(resolve, 750));
      const second = Schema.decodeUnknownSync(Envelope)(
        await send({
          operation: "resume",
          input: {
            requestId: first.result.requestId,
            response: { action: "accept", content: { name: "first" } },
          },
        }),
      );
      assert.equal(second.started, 1);
      assert.equal(second.released, 0);
      assert.ok(second.result.status === "input-required", JSON.stringify(second));
      const final = Schema.decodeUnknownSync(Envelope)(
        await send({
          operation: "resume",
          input: {
            requestId: second.result.requestId,
            response: { action: "accept", content: { name: "second" } },
          },
        }),
      );
      assert.equal(final.started, 1);
      assert.equal(final.released, 1);
      assert.ok(
        final.result.status === "completed" && final.result.execution.ok,
        JSON.stringify(final),
      );
      assert.deepEqual(final.result.execution.value, {
        marker: 1,
        first: "first",
        second: { action: "accept", content: { name: "second" } },
      });
      const browser = Schema.decodeUnknownSync(Envelope)(await send({ operation: "execute" }));
      assert.ok(browser.result.status === "input-required");
      const browserId = browser.result.requestId;
      const view = Schema.decodeUnknownSync(
        Schema.Struct({ result: Schema.Struct({ status: Schema.Literal("pending") }) }),
      )(await send({ operation: "browser-get", requestId: browserId }));
      assert.equal(view.result.status, "pending");
      await new Promise((resolve) => setTimeout(resolve, 750));
      const recorded = Schema.decodeUnknownSync(
        Schema.Struct({
          result: Schema.Struct({ status: Schema.Literal("answered") }),
          started: Schema.Number,
          released: Schema.Number,
        }),
      )(
        await send({
          operation: "browser-answer",
          requestId: browserId,
          response: { action: "accept", content: { name: "browser" } },
        }),
      );
      assert.equal(recorded.started, 2);
      assert.equal(recorded.released, 1);
      const browserNext = Schema.decodeUnknownSync(Envelope)(
        await send({ operation: "browser-resume", requestId: browserId }),
      );
      assert.ok(browserNext.result.status === "input-required");
      await send({
        operation: "browser-answer",
        requestId: browserNext.result.requestId,
        response: { action: "cancel" },
      });
      const browserDone = Schema.decodeUnknownSync(Envelope)(
        await send({ operation: "browser-resume", requestId: browserNext.result.requestId }),
      );
      assert.equal(browserDone.started, 2);
      assert.equal(browserDone.released, 2);
      assert.ok(browserDone.result.status === "completed" && browserDone.result.execution.ok);
      assert.deepEqual(browserDone.result.execution.value, {
        marker: 1,
        first: "browser",
        second: { action: "cancel" },
      });
      await send({ operation: "close" });
    } finally {
      await mf.dispose();
    }
  },
);

test("cached Worker code evaluates fresh and owns each call's cancellation independently", async () => {
  const app = await bundle(
    appBridge,
    `import { defineApp, mutation, object, number } from "apps";
    let boot; let evaluations = 0;
    export default defineApp({ accounts: {} }, async () => {
      boot ??= crypto.randomUUID(); const evaluation = ++evaluations;
      return {  mutations: { wait: mutation({ input: object({ delay: number() }) }, async ({ signal }, { delay }) => {
        await new Promise((resolve, reject) => { const timer = setTimeout(resolve, delay); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true }); });
        return { boot, evaluation };
      }) } };
    });`,
  );
  const rpc = appRpcBridge("app.js");
  const parent =
    await bundle(`import { Schema } from "effect"; import { AppRpcInvocation } from "./src/implementation/elicitation.ts"; export default { async fetch(request, env) {
    const get = id => env.LOADER.get(id, () => ({ compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"], mainModule: "rpc.js", modules: { "rpc.js": ${JSON.stringify(rpc)}, "app.js": ${JSON.stringify(app)} } })).getEntrypoint();
    const body = delay => JSON.stringify({ command: { operation: "call", tool: "mutations.wait", input: { delay } }, accounts: {} });
    const first = await get("same-context").start(body(10000), {}, null);
    Schema.decodeUnknownSync(AppRpcInvocation)(first);
    const second = await get("same-context").start(body(100), {}, null);
    const cancelled = first.result().then(() => false, () => true);
    await first.cancel(); first[Symbol.dispose]();
    const kept = await second.result(); await second.cancel(); second[Symbol.dispose]();
    const again = await invokeRuntime(get("same-context"), body(1), {}, null);
    const changed = await invokeRuntime(get("changed-account-context"), body(1), {}, null);
    return Response.json({ cancelled: await cancelled, kept, again, changed });
  } };`);
  const mf = new Miniflare({
    modules: true,
    script: parent,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    workerLoaders: { LOADER: {} },
  });
  try {
    const response = await mf.dispatchFetch("https://test/");
    assert.equal(response.status, 200, await response.clone().text());
    const outcome = Schema.Struct({
      ok: Schema.Literal(true),
      value: Schema.Struct({ boot: Schema.String, evaluation: Schema.Number }),
    });
    const result = Schema.decodeUnknownSync(
      Schema.Struct({ cancelled: Schema.Boolean, kept: outcome, again: outcome, changed: outcome }),
    )(await response.json());
    assert.equal(result.cancelled, true);
    assert.equal(result.kept.value.boot, result.again.value.boot);
    assert.ok(result.again.value.evaluation > result.kept.value.evaluation);
    assert.notEqual(result.changed.value.boot, result.again.value.boot);
  } finally {
    await mf.dispose();
  }
});
