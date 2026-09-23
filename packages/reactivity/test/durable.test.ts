import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { Schema } from "effect";
import { Miniflare } from "miniflare";

const Stats = Schema.Struct({ instance: Schema.String, evaluations: Schema.Number });

test(
  "Durable Object commits survive hibernation and reauthorize live queries",
  { timeout: 30_000 },
  async () => {
    const bundle = await build({
      entryPoints: [new URL("./fixtures/durable-worker.mjs", import.meta.url).pathname],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      external: ["cloudflare:workers"],
    });
    const script = bundle.outputFiles[0]?.text;
    assert.ok(script);
    const miniflare = new Miniflare({
      name: "live-test",
      modules: true,
      script,
      compatibilityDate: "2026-07-30",
      durableObjects: { LIVE: { className: "LiveDatabase", useSQLite: true } },
    });
    try {
      const response = await miniflare.dispatchFetch("https://test/subscribe", {
        headers: { Upgrade: "websocket" },
      });
      assert.equal(
        response.status,
        101,
        response.status === 101 ? "Expected WebSocket upgrade" : await response.text(),
      );
      const socket = response.webSocket;
      assert.ok(socket);
      const messages: Array<unknown> = [];
      const waiters: Array<(message: unknown) => void> = [];
      socket.addEventListener("message", (event) => {
        const message: unknown = JSON.parse(String(event.data));
        const waiter = waiters.shift();
        if (waiter === undefined) messages.push(message);
        else waiter(message);
      });
      const next = () =>
        messages.length > 0
          ? Promise.resolve(messages.shift())
          : new Promise<unknown>((resolve) => {
              waiters.push(resolve);
            });
      socket.accept();
      assert.deepEqual(await next(), { type: "snapshot", revision: 0, value: [] });
      const before = Schema.decodeUnknownSync(Stats)(
        await (await miniflare.dispatchFetch("https://test/stats")).json(),
      );

      assert.equal(
        (await miniflare.dispatchFetch("https://test/unrelated", { method: "POST" })).status,
        200,
      );
      assert.equal(
        (
          await miniflare.dispatchFetch("https://test/rollback", {
            method: "POST",
            body: "not committed",
          })
        ).status,
        409,
      );
      const unchanged = Schema.decodeUnknownSync(Stats)(
        await (await miniflare.dispatchFetch("https://test/stats")).json(),
      );
      assert.equal(unchanged.evaluations, before.evaluations);

      assert.equal(
        (await miniflare.dispatchFetch("https://test/write", { method: "POST", body: "first" }))
          .status,
        200,
      );
      assert.deepEqual(await next(), {
        type: "snapshot",
        revision: 2,
        value: [{ id: 1, body: "first" }],
      });

      // Kill in-memory coordination after the DB commit but before delivery, while
      // keeping the actual platform WebSocket alive in its hibernating state.
      assert.equal(
        (
          await miniflare.dispatchFetch("https://test/failed-delivery", {
            method: "POST",
            body: "second",
          })
        ).status,
        200,
      );
      await miniflare.unsafeEvictDurableObject("live-test", "LiveDatabase", {
        name: "database",
        webSockets: "hibernate",
      });
      // No HTTP request wakes the object: the persisted alarm must do it.
      assert.deepEqual(await next(), {
        type: "snapshot",
        revision: 3,
        value: [
          { id: 1, body: "first" },
          { id: 2, body: "second" },
        ],
      });
      const restored = Schema.decodeUnknownSync(Stats)(
        await (await miniflare.dispatchFetch("https://test/stats")).json(),
      );
      assert.notEqual(restored.instance, before.instance);

      assert.equal(
        (await miniflare.dispatchFetch("https://test/nested", { method: "POST" })).status,
        200,
      );
      assert.deepEqual(await next(), {
        type: "snapshot",
        revision: 4,
        value: [
          { id: 1, body: "first" },
          { id: 2, body: "second" },
          { id: 3, body: "third" },
        ],
      });

      // Authorization is resolved again on execution; a saved caller reference is
      // not a saved grant and does not let the restored socket receive more data.
      assert.equal(
        (await miniflare.dispatchFetch("https://test/revoke", { method: "POST" })).status,
        200,
      );
      assert.deepEqual(await next(), { type: "error", code: "unauthorized" });
      socket.close();
    } finally {
      await miniflare.dispose();
    }
  },
);
