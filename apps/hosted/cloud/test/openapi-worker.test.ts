/** Catch ApiDOM initialization loss in Alchemy's production bundler, inside real workerd. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WorkerBundle } from "../node_modules/alchemy/lib/Cloudflare/Workers/Sources/Rolldown.js";
import { Miniflare } from "miniflare";

test(
  "Alchemy-bundled Swagger resolves 3.0 and 3.1 objects and preserves recursive validation",
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "executor-openapi-worker-"));
    try {
      const bundle = await Effect.runPromise(
        Effect.gen(function* () {
          const bundler = yield* WorkerBundle;
          return yield* bundler.build({
            id: "openapi-regression",
            main: fileURLToPath(new URL("./openapi-worker-fixture.ts", import.meta.url)),
            compatibility: { date: "2026-07-30", flags: ["nodejs_compat"] },
            entry: { kind: "external" },
            stack: { name: "openapi-regression", stage: "local" },
            extraOptions: { output: { dir: directory, sourcemap: false } },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      const main = bundle.files[0];
      assert.ok(main);
      const runtime = new Miniflare({
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        modules: bundle.files.map((file) => ({
          type: "ESModule",
          path: join(directory, basename(file.path)),
          contents: file.content,
        })),
        modulesRoot: directory,
      });
      try {
        const response = await runtime.dispatchFetch("https://fixture.test/");
        assert.equal(response.status, 200, await response.clone().text());
        assert.deepEqual(
          await response.json(),
          ["3.0.3", "3.1.0"].map((openapi) => ({
            openapi,
            rejects: true,
            result: {
              ok: true,
              value: {
                url: "https://example.test/items/;role=admin",
                body: { label: "parent", child: { label: "leaf" } },
              },
            },
          })),
        );
      } finally {
        await runtime.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
