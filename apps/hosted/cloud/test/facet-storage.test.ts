import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare, createFetchMock } from "miniflare";
import { Schema } from "effect";
import { appBridge, appFacetBridge } from "../src/implementation/app-bridge.ts";
import { bundleHarness } from "../../../../packages/app-data/test/bundle.ts";

const Result = Schema.Struct({
  ok: Schema.Literal(true),
  value: Schema.Struct({
    reads: Schema.Number,
    rows: Schema.Array(Schema.Struct({ body: Schema.String })),
  }),
});
const OperationResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      _tag: Schema.Literal("ElicitationFailed"),
      reason: Schema.Literal("transaction"),
    }),
  }),
]);
test(
  "the generated hosted bridge runs typed author code with isolated globals and persistent data",
  { timeout: 30_000 },
  async () => {
    const root = new URL("./fixtures/data-app/", import.meta.url).pathname;
    const bundle = await build({
      stdin: { contents: appFacetBridge("bridge.js"), resolveDir: root },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      target: "es2022",
      external: ["cloudflare:workers"],
      plugins: [
        {
          name: "bridge",
          setup(build) {
            build.onResolve({ filter: /bridge\.js$/ }, () => ({
              path: "bridge.js",
              namespace: "generated",
            }));
            build.onLoad({ filter: /.*/, namespace: "generated" }, () => ({
              contents: appBridge([]),
              resolveDir: root,
              loader: "ts",
            }));
          },
        },
      ],
    });
    const code = bundle.outputFiles[0]?.text;
    assert.ok(code);
    const fetchMock = createFetchMock();
    fetchMock.disableNetConnect();
    fetchMock
      .get("https://fixture.example")
      .intercept({ path: "/read" })
      .reply(200, "external-read");
    const mf = new Miniflare({
      fetchMock,
      name: "author",
      script: await bundleHarness(code),
      modules: true,
      compatibilityDate: "2026-07-30",
      bindings: { TEST_TOKEN: "test-only" },
      workerLoaders: { LOADER: {} },
      durableObjects: { ROOT: { className: "Supervisor", useSQLite: true } },
    });
    try {
      const send = (app: string, version: string, write = false) =>
        mf.dispatchFetch(`https://test/data?app=${app}&version=${version}`, {
          method: "POST",
          headers: { authorization: "Bearer test-only" },
          body: JSON.stringify({
            write,
            accounts: {},
            command: {
              operation: write ? "mutate" : "query",
              name: write ? "add" : "list",
              input: write ? { body: "kept" } : {},
            },
          }),
        });
      const query = async (app: string, version: string) => {
        const response = await send(app, version);
        assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
        return Schema.decodeUnknownSync(Result)(await response.json()).value;
      };
      for (const [operation, name, tool, expected] of [
        ["query", "external", undefined, { ok: true, value: "external-read" }],
        [
          "call",
          undefined,
          "mutations.ask",
          { ok: false, error: { _tag: "ElicitationFailed", reason: "transaction" } },
        ],
      ] as const) {
        const response = await mf.dispatchFetch("https://test/data?app=external", {
          method: "POST",
          headers: { authorization: "Bearer test-only" },
          body: JSON.stringify({
            write: false,
            accounts: {},
            command: { operation, name, tool, input: {} },
          }),
        });
        assert.equal(response.status, expected.ok ? 200 : 409, await response.clone().text());
        assert.deepEqual(
          Schema.decodeUnknownSync(OperationResult)(await response.json()),
          expected,
        );
      }
      assert.deepEqual(await query("a", "v1"), { reads: 1, rows: [] });
      const added = await send("a", "v1", true);
      assert.equal(added.status, 200, await added.text());
      assert.deepEqual(await query("a", "v1"), { reads: 2, rows: [{ body: "kept" }] });
      assert.deepEqual(await query("b", "v1"), { reads: 1, rows: [] });
      assert.deepEqual(await query("a", "v2"), { reads: 1, rows: [{ body: "kept" }] });
    } finally {
      await mf.dispose();
    }
  },
);
