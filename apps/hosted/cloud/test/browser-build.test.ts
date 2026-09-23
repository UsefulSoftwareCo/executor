/** Compile real React/CSS/assets inside workerd, retain them in R2, and reopen the Worker. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Schema } from "effect";
import { HostResponse } from "apps/contracts";

const server = `import { defineApp, object, query } from "apps";
const SERVER_ONLY_VALUE = "synthetic-server-private-marker";
export default defineApp({ accounts: {} }, async () => ({  queries: {
  greet: query({ description: "Greet", input: object({}) }, async () => ({ hello: "server", privateValue: SERVER_ONLY_VALUE }))
} }));`;
const files = [
  { path: "index.ts", content: server },
  {
    path: "package.json",
    content: JSON.stringify({ dependencies: { react: "19.2.0", "react-dom": "19.2.0" } }),
  },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><base href="https://wrong.example/"><link rel="stylesheet" href="./theme.css"></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
  },
  {
    path: "ui/main.tsx",
    content:
      'import { createRoot } from "react-dom/client"; import { createAppClient } from "apps/client"; import { object, string } from "apps"; import logo from "./logo.svg"; import "./main.css"; import("./lazy.ts").then(value => console.log(value.ready)); const client=createAppClient(); const result=object({hello:string(),privateValue:string()}); createRoot(document.getElementById("root")).render(<main className="p-[13px] md:p-8"><img src={logo}/><button onClick={()=>client.query({name:"greet",kind:"query"},{},result)}>Browser-only marker</button></main>);',
  },
  {
    path: "ui/main.css",
    content:
      '@import "tailwindcss"; main { color: rgb(12, 34, 56); background-image: url("./logo.svg") }',
  },
  { path: "ui/theme.css", content: "body { margin: 0; }" },
  { path: "ui/logo.svg", content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>' },
  { path: "ui/public/icon.svg", content: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
  { path: "ui/lazy.ts", content: 'export const ready = "Lazy browser chunk";' },
  { path: "server/private.ts", content: 'export const secret = "another-server-marker";' },
];

test(
  "cloud compilation retains the whole UI, preserves server isolation and survives restart",
  { timeout: 120_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped();
          const root = yield* path.fromFileUrl(new URL("../", import.meta.url));
          const bundle = yield* Effect.promise(() =>
            build({
              absWorkingDir: root,
              entryPoints: ["test/fixtures/browser-build-worker.ts"],
              outdir: directory,
              bundle: true,
              format: "esm",
              platform: "browser",
              target: "es2022",
              write: false,
              loader: { ".wasm": "copy" },
            }),
          );
          const modules = bundle.outputFiles.map((file) =>
            file.path.endsWith(".wasm")
              ? { type: "CompiledWasm" as const, path: file.path, contents: file.contents }
              : { type: "ESModule" as const, path: file.path, contents: file.text },
          );
          modules.sort((a, b) => Number(a.type !== "ESModule") - Number(b.type !== "ESModule"));
          const settings = {
            modules,
            modulesRoot: directory,
            compatibilityDate: "2026-07-30",
            compatibilityFlags: ["nodejs_compat"],
            r2Buckets: ["BUILDS"],
            r2Persist: path.join(directory, "r2"),
            workerLoaders: { LOADER: {} },
          };
          const fixtureBuild = "bld_browser_fixture";
          let expectedHtml = "";
          yield* Effect.scoped(
            Effect.gen(function* () {
              const worker = yield* Effect.acquireRelease(
                Effect.sync(() => new Miniflare(settings)),
                (worker) => Effect.promise(() => worker.dispose()),
              );
              const response = yield* Effect.promise(() =>
                worker.dispatchFetch("https://test/build", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ build: fixtureBuild, files }),
                }),
              );
              assert.equal(
                response.status,
                200,
                yield* Effect.promise(() => response.clone().text()),
              );
              const stored = yield* Effect.promise(() =>
                worker.dispatchFetch(`https://test/bundle?build=${fixtureBuild}`),
              );
              const bundleText = yield* Effect.promise(() => stored.text());
              assert.match(bundleText, /synthetic-server-private-marker/);
              assert.doesNotMatch(bundleText, /Browser-only marker/);
              const html = yield* Effect.promise(() =>
                worker.dispatchFetch(`https://test/asset?build=${fixtureBuild}&path=index.html`),
              );
              assert.equal(html.headers.get("content-type"), "text/html");
              expectedHtml = yield* Effect.promise(() => html.text());
              assert.match(expectedHtml, /executor-ui/);
              assert.doesNotMatch(expectedHtml, /wrong\.example/);
              const references = [...expectedHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map(
                (match) => match[1],
              );
              assert.equal(
                references.length,
                3,
                "module entry, linked CSS, and CSS imported by the module",
              );
              assert.ok(references.some((value) => value?.endsWith(".js")));
              const styles: string[] = [];
              for (const name of references) {
                assert.ok(name);
                const asset = yield* Effect.promise(() =>
                  worker.dispatchFetch(`https://test/asset?build=${fixtureBuild}&path=${name}`),
                );
                assert.equal(asset.status, 200);
                const body = yield* Effect.promise(() => asset.text());
                assert.doesNotMatch(body, /synthetic-server-private-marker|another-server-marker/);
                if (name.endsWith(".css")) styles.push(body);
                if (name.endsWith(".js")) {
                  assert.match(body, /Browser-only marker/);
                  assert.doesNotMatch(body, /from\s*["'](?:apps|react)/);
                  const image = /\.\/([^"' ]+\.svg)/.exec(body)?.[1];
                  assert.ok(image);
                  assert.equal(
                    (yield* Effect.promise(() =>
                      worker.dispatchFetch(
                        `https://test/asset?build=${fixtureBuild}&path=${image}`,
                      ),
                    )).status,
                    200,
                  );
                }
              }
              assert.match(styles.join("\n"), /padding:\s*13px/);
              assert.doesNotMatch(styles.join("\n"), /@(?:tailwind|theme)\b/);
              assert.equal(
                (yield* Effect.promise(() =>
                  worker.dispatchFetch(`https://test/asset?build=${fixtureBuild}&path=icon.svg`),
                )).status,
                200,
              );
              for (const name of ["index.ts", "server/private.ts", "../bundle.js", "missing.js"])
                assert.equal(
                  (yield* Effect.promise(() =>
                    worker.dispatchFetch(
                      `https://test/asset?build=${fixtureBuild}&path=${encodeURIComponent(name)}`,
                    ),
                  )).status,
                  404,
                );
              const bucket = yield* Effect.promise(() => worker.getR2Bucket("BUILDS"));
              const objects = yield* Effect.promise(() => bucket.list());
              assert.ok(objects.objects.some((object) => object.key === `${fixtureBuild}.json`));
              assert.ok(
                objects.objects.some(
                  (object) =>
                    object.key.startsWith(`${fixtureBuild}/ui/`) && object.key.endsWith(".svg"),
                ),
              );
              const browserObjects = objects.objects.filter((object) =>
                object.key.startsWith(`${fixtureBuild}/ui/`),
              );
              assert.ok(
                browserObjects.filter((object) => object.key.endsWith(".js")).length >= 2,
                "dynamic chunks are retained too",
              );
              for (const object of browserObjects) {
                const storedAsset = yield* Effect.promise(() => bucket.get(object.key));
                assert.ok(storedAsset);
                assert.doesNotMatch(
                  yield* Effect.promise(() => storedAsset.text()),
                  /synthetic-server-private-marker|another-server-marker/,
                );
              }

              // Type-only server references are erased; executable and indirect server imports fail closed.
              for (const [name, content] of [
                ["server", 'import app from "../index.ts"; console.log(app);'],
                ["private", 'import { secret } from "../server/private.ts"; console.log(secret);'],
                [
                  "framework",
                  'import { createAppHandler } from "apps/host"; console.log(createAppHandler);',
                ],
                ["unresolved", 'import thing from "not-declared-package"; console.log(thing);'],
              ] as const) {
                const bad = files
                  .filter((file) => file.path !== "package.json")
                  .map((file) => (file.path === "ui/main.tsx" ? { ...file, content } : file));
                const rejected = yield* Effect.promise(() =>
                  worker.dispatchFetch("https://test/build", {
                    method: "POST",
                    body: JSON.stringify({ build: `bld_${name}`, files: bad }),
                  }),
                );
                assert.equal(rejected.status, 422);
                assert.equal(yield* Effect.promise(() => bucket.get(`bld_${name}.json`)), null);
              }
              const simple = files
                .filter((file) => file.path !== "package.json")
                .map((file) =>
                  file.path === "ui/main.tsx"
                    ? {
                        ...file,
                        content:
                          'import type app from "../index.ts"; document.body.textContent="Typed UI";',
                      }
                    : file,
                );
              const failed = yield* Effect.promise(() =>
                worker.dispatchFetch("https://test/build", {
                  method: "POST",
                  headers: { "x-fail-retention": "yes" },
                  body: JSON.stringify({ build: "bld_retention", files: simple }),
                }),
              );
              assert.equal(failed.status, 422);
              assert.deepEqual(yield* Effect.promise(() => failed.json()), { stage: "retain" });
              assert.equal(yield* Effect.promise(() => bucket.get("bld_retention.json")), null);
              const noUi = yield* Effect.promise(() =>
                worker.dispatchFetch("https://test/build", {
                  method: "POST",
                  body: JSON.stringify({
                    build: "bld_without_ui",
                    files: [{ path: "index.ts", content: server }],
                  }),
                }),
              );
              assert.equal(noUi.status, 200);
              assert.equal(
                (yield* Effect.promise(() =>
                  worker.dispatchFetch("https://test/asset?build=bld_without_ui&path=index.html"),
                )).status,
                404,
              );
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const worker = yield* Effect.acquireRelease(
                Effect.sync(() => new Miniflare(settings)),
                (worker) => Effect.promise(() => worker.dispose()),
              );
              const html = yield* Effect.promise(() =>
                worker.dispatchFetch(`https://test/asset?build=${fixtureBuild}&path=index.html`),
              );
              assert.equal(yield* Effect.promise(() => html.text()), expectedHtml);
              const call = yield* Effect.promise(() =>
                worker.dispatchFetch(`https://test/invoke?build=${fixtureBuild}`),
              );
              assert.equal(call.status, 200, yield* Effect.promise(() => call.clone().text()));
              assert.deepEqual(
                Schema.decodeUnknownSync(HostResponse)(yield* Effect.promise(() => call.json())),
                {
                  ok: true,
                  value: { hello: "server", privateValue: "synthetic-server-private-marker" },
                },
              );
            }),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    ),
);
