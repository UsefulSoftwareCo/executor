/** Explicit opt-in cloud proof. Creates only named synthetic test resources and removes them on exit. */
import { Resolver } from "node:dns";
import { Agent, fetch, WebSocket } from "undici";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { scale, pool } from "./scale.ts";
import { bundleHarness } from "./bundle.ts";

// Resolve the new test hostname through Cloudflare DNS; the system resolver can cache NXDOMAIN.
const resolver = new Resolver();
resolver.setServers(["1.1.1.1"]);
const resolved = new Map<string, readonly string[]>();
const dispatcher = new Agent({
  connect: {
    lookup: (hostname, options, callback) => {
      const saved = resolved.get(hostname);
      if (saved !== undefined && saved[0] !== undefined)
        return callback(
          null,
          options.all ? saved.map((address) => ({ address, family: 4 })) : saved[0],
          4,
        );
      resolver.resolve4(hostname, (error, addresses) => {
        if (error) return callback(error, "", 4);
        const first = addresses[0];
        if (first === undefined) return callback(new Error("No IPv4 address"), "", 4);
        resolved.set(hostname, addresses);
        callback(
          null,
          options.all ? addresses.map((address) => ({ address, family: 4 })) : first,
          4,
        );
      });
    },
  },
});
const cloudFetch: typeof fetch = (input, init) => fetch(input, { ...init, dispatcher });
const directory = new URL("../../../.local/facet-storage-test/", import.meta.url);
await mkdir(directory, { recursive: true });
const name = "executor-facet-storage-test";
const hostname = "facet-storage-test.executor.website";
const config = new URL("wrangler.json", directory).pathname;
await writeFile(new URL("worker.mjs", directory), await bundleHarness());
await writeFile(
  config,
  JSON.stringify({
    name,
    main: "worker.mjs",
    compatibility_date: "2026-07-30",
    workers_dev: false,
    routes: [{ pattern: hostname, custom_domain: true }],
    worker_loaders: [{ binding: "LOADER" }],
    durable_objects: { bindings: [{ name: "ROOT", class_name: "Supervisor" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Supervisor"] }],
  }),
);
const wrangler = (args: string[], input?: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("bunx", ["wrangler@4.135.0", ...args, "--config", config], {
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...process.env, CI: "true" },
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Wrangler exited ${code}`)),
    );
    child.stdin.end(input);
  });
const token = crypto.randomUUID() + crypto.randomUUID();
let deployed = false;
let tail: ReturnType<typeof spawn> | undefined;
let filter: ReturnType<typeof spawn> | undefined;
try {
  await wrangler(["deploy"]);
  deployed = true;
  await wrangler(["secret", "put", "TEST_TOKEN"], token);
  filter = spawn(process.execPath, [new URL("./filtered-tail.mjs", import.meta.url).pathname], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  tail = spawn("bunx", ["wrangler@4.135.0", "tail", name, "--format", "json"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (tail.stdout !== null && filter.stdin !== null) tail.stdout.pipe(filter.stdin);
  const url = `https://${hostname}`;
  const send = (app: string, body: unknown, path = "/data") =>
    cloudFetch(`${url}${path}?app=${app}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      ready =
        (await cloudFetch(`${url}/data?app=a`, { signal: AbortSignal.timeout(5000) })).status ===
        401;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.ok(ready, "Custom domain did not become ready within two minutes");
  const write = {
    write: true,
    operations: [{ kind: "insert", table: "messages", value: { mailbox: "synthetic", score: 42 } }],
  };
  const query = {
    write: false,
    operations: [
      {
        kind: "query",
        plan: { table: "messages", index: "by_creation", clauses: [], order: "asc" },
        terminal: { kind: "count" },
      },
    ],
  };
  const first = await send("proof-a", write);
  assert.equal(first.status, 200, await first.text());
  assert.equal((await send("proof-a", { ...write, rollback: true })).status, 409);
  assert.deepEqual(await (await send("proof-a", query)).json(), { ok: true, value: [1] });
  assert.deepEqual(await (await send("proof-b", query)).json(), { ok: true, value: [0] });
  assert.equal((await send("proof-a", {}, "/restart")).status, 200);
  assert.deepEqual(await (await send("proof-a", query)).json(), { ok: true, value: [1] });
  const sockets: WebSocket[] = [];
  const revisions: number[] = [];
  try {
    await pool(100, 10, async (index) => {
      const socket = new WebSocket(`wss://${hostname}/changes?app=hot`, {
        headers: { authorization: `Bearer ${token}` },
        dispatcher,
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Live subscription timed out")), 15_000);
        socket.addEventListener(
          "error",
          () => {
            clearTimeout(timer);
            reject(new Error("Live subscription failed"));
          },
          { once: true },
        );
        socket.addEventListener("message", (event) => {
          const value = JSON.parse(String(event.data));
          revisions[index] = value.revision;
          clearTimeout(timer);
          resolve();
        });
      });
    });
    if (process.argv.includes("--scale") || process.argv.includes("--hot")) {
      const results = await scale(send);
      const deadline = Date.now() + 30_000;
      while (revisions.some((revision) => revision < 200) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(revisions.length, 100);
      assert.ok(revisions.every((revision) => revision === 200));
      await writeFile(
        new URL("results.json", directory),
        JSON.stringify(
          { date: new Date().toISOString(), hostname, clients: 100, revisions, results },
          null,
          2,
        ),
      );
      console.log("100 live clients caught up to all 200 hot-app mutations");
    } else {
      assert.equal((await send("hot", write)).status, 200);
      const deadline = Date.now() + 10_000;
      while (revisions.some((revision) => revision < 1) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(revisions.every((revision) => revision === 1));
      console.log("100 live clients received the mutation revision");
    }
  } finally {
    for (const socket of sockets) socket.close();
  }
  console.log(
    JSON.stringify({
      url,
      passed: [
        "unauthenticated denied",
        "facet write",
        "rollback",
        "app isolation",
        "restart persistence",
      ],
    }),
  );
} finally {
  // Let Cloudflare deliver the final trace events before closing the diagnostic session.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  tail?.kill();
  filter?.kill();
  if (deployed) await wrangler(["delete", "--force"]);
  await dispatcher.close();
}
