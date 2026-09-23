import assert from "node:assert/strict";
import { test } from "node:test";
import { Miniflare } from "miniflare";
import { bundleHarness } from "./bundle.ts";
import { pool } from "./scale.ts";

test(
  "one app serializes a hundred clients without losing writes or live revisions",
  { timeout: 60_000 },
  async () => {
    const mf = new Miniflare({
      name: "hot",
      modules: true,
      script: await bundleHarness(),
      compatibilityDate: "2026-07-30",
      bindings: { TEST_TOKEN: "test-only" },
      workerLoaders: { LOADER: {} },
      durableObjects: { ROOT: { className: "Supervisor", useSQLite: true } },
    });
    try {
      const sockets = await Promise.all(
        Array.from({ length: 100 }, async () => {
          const response = await mf.dispatchFetch("https://test/changes?app=hot", {
            headers: { authorization: "Bearer test-only", Upgrade: "websocket" },
          });
          assert.equal(response.status, 101);
          const socket = response.webSocket;
          assert.ok(socket);
          socket.accept();
          return socket;
        }),
      );
      await pool(200, 100, async () => {
        const response = await mf.dispatchFetch("https://test/data?app=hot", {
          method: "POST",
          headers: { authorization: "Bearer test-only" },
          body: JSON.stringify({
            write: true,
            operations: Array.from({ length: 5 }, () => ({
              kind: "insert",
              table: "messages",
              value: { mailbox: "hot", score: 1 },
            })),
          }),
        });
        assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
      });
      const response = await mf.dispatchFetch("https://test/data?app=hot", {
        method: "POST",
        headers: { authorization: "Bearer test-only" },
        body: JSON.stringify({
          write: false,
          operations: [
            {
              kind: "query",
              plan: { table: "messages", index: "by_creation", order: "asc", clauses: [] },
              terminal: { kind: "count" },
            },
          ],
        }),
      });
      assert.deepEqual(await response.json(), { ok: true, value: [1000] });
      for (const socket of sockets) socket.close();
    } finally {
      await mf.dispose();
    }
  },
);
