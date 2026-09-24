/** Run the production app bridge in a real workerd Dynamic Worker. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { Schema } from "effect";
import { TelemetryBatch } from "@executor-js/telemetry";
import { appBridge } from "../src/implementation/app-bridge.ts";

test(
  "Dynamic Worker preserves parent context and flushes failed invocation telemetry",
  { timeout: 30_000 },
  async () => {
    const bundled = await build({
      stdin: { contents: appBridge([]), resolveDir: process.cwd(), sourcefile: "bridge.ts" },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      target: "es2022",
      plugins: [
        {
          name: "synthetic-app",
          setup(builder) {
            builder.onResolve({ filter: /^\.\/index\.ts$/ }, () => ({
              path: "fixture",
              namespace: "fixture",
            }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              loader: "ts",
              resolveDir: process.cwd(),
              contents: `import { query, mutation, defineApp, object } from "apps";
export default defineApp({ accounts: {} }, async (appContext) => ({  mutations: { fail: mutation({ description: "Synthetic failure",
            input: object({}) }, async (operationContext, _input) => {
            throw new Error("Synthetic tool failure");
        }) } }));
`,
            }));
          },
        },
      ],
    });
    const source = bundled.outputFiles[0]?.text;
    assert.ok(source);
    const mf = new Miniflare({
      modules: true,
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
      workerLoaders: { LOADER: {} },
      script: `export default { async fetch(request, env) {
      const worker = env.LOADER.get(null, () => ({ compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"],
        mainModule: "app.js", modules: { "app.js": ${JSON.stringify(source)} } }));
      return worker.getEntrypoint().fetch(request);
    } }`,
    });
    try {
      const response = await mf.dispatchFetch("http://worker/dispatch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
        },
        body: JSON.stringify({
          command: { operation: "call", tool: "mutations.fail", input: {} },
          accounts: {},
        }),
      });
      assert.equal(response.status, 500);
      const body = Schema.decodeUnknownSync(
        Schema.Struct({ ok: Schema.Boolean, telemetry: TelemetryBatch }),
      )(await response.json());
      assert.equal(body.ok, false);
      assert.equal(body.telemetry.dropped, 0);
      const traces = body.telemetry.traces.join("");
      assert.match(traces, /11111111111111111111111111111111/);
      assert.match(traces, /2222222222222222/);
      assert.match(traces, /Synthetic tool failure/);
    } finally {
      await mf.dispose();
    }
  },
);
