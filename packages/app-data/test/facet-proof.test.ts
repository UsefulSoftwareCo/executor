import assert from "node:assert/strict";
import { test } from "node:test";
import { Miniflare } from "miniflare";
import { bundleHarness } from "./bundle.ts";

test(
  "Effect SQL facets preserve isolated data across rollback, eviction and code replacement",
  { timeout: 30_000 },
  async () => {
    const mf = new Miniflare({
      name: "facets",
      modules: true,
      script: await bundleHarness(),
      compatibilityDate: "2026-07-30",
      bindings: { TEST_TOKEN: "test-only" },
      workerLoaders: { LOADER: {} },
      durableObjects: { ROOT: { className: "Supervisor", useSQLite: true } },
    });
    const dispatch = (url: string, init: { method?: string; body?: string } = {}) =>
      mf.dispatchFetch(url, { ...init, headers: { authorization: "Bearer test-only" } });
    const write = (app: string, rollback = false) =>
      dispatch(`https://test/data?app=${app}`, {
        method: "POST",
        body: JSON.stringify({
          write: true,
          operations: [{ kind: "insert", table: "messages", value: { mailbox: "one", score: 42 } }],
          rollback,
        }),
      });
    const read = async (app: string) => {
      const response = await dispatch(`https://test/data?app=${app}`, {
        method: "POST",
        body: JSON.stringify({
          write: false,
          operations: [
            {
              kind: "query",
              plan: { table: "messages", index: "by_creation", clauses: [], order: "asc" },
              terminal: { kind: "count" },
            },
          ],
        }),
      });
      assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
      return await response.json();
    };
    try {
      const response = await write("a");
      assert.equal(response.status, 200, await response.text());
      assert.equal((await write("a", true)).status, 409);
      assert.deepEqual(await read("a"), { ok: true, value: [1] });
      assert.deepEqual(await read("b"), { ok: true, value: [0] });
      const changed = await mf.dispatchFetch("https://test/changes?app=a", {
        headers: { authorization: "Bearer test-only", Upgrade: "websocket" },
      });
      assert.equal(changed.status, 101);
      const socket = changed.webSocket;
      assert.ok(socket);
      const messages: unknown[] = [];
      const waiters: Array<(value: unknown) => void> = [];
      socket.addEventListener("message", (event) => {
        const value: unknown = JSON.parse(String(event.data));
        const waiter = waiters.shift();
        if (waiter === undefined) messages.push(value);
        else waiter(value);
      });
      const next = () =>
        messages.length > 0
          ? Promise.resolve(messages.shift())
          : new Promise<unknown>((resolve) => {
              waiters.push(resolve);
            });
      socket.accept();
      assert.deepEqual(await next(), { revision: 2 });
      await dispatch("https://test/pending?app=a");
      await mf.unsafeEvictDurableObject("facets", "Supervisor", {
        name: "a",
        webSockets: "hibernate",
      });
      assert.deepEqual(await next(), { revision: 3 });
      socket.close();
      assert.deepEqual(await read("a"), { ok: true, value: [1] });
      await mf.unsafeEvictDurableObject("facets", "Supervisor", { name: "a" });
      assert.deepEqual(await read("a"), { ok: true, value: [1] });
    } finally {
      await mf.dispose();
    }
  },
);
