// Dependency regression: real Workers, HTTP calls, persisted SQLite, and SIGKILL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const backend = process.env.WORKFLOW_RECOVERY_BACKEND ?? "miniflare";
if (!["miniflare", "alchemy"].includes(backend)) throw new Error("Unknown recovery backend");
const fixture = fileURLToPath(new URL(`./fixtures/${backend}-recovery-host.mjs`, import.meta.url));

async function until(check, description, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(40);
  }
  assert.fail(`Timed out: ${description}`);
}

async function startRuntime(storage, upstream) {
  const child = spawn(process.execPath, [fixture, storage, upstream], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let ready;
  let exited = false;
  const exit = once(child, "exit").then(() => {
    exited = true;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    logs += line + "\n";
    if (line.startsWith('{"ready":')) ready = JSON.parse(line).ready;
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });
  const stop = async (signal = "SIGTERM") => {
    if (!exited) {
      // The detached group includes workerd, so SIGKILL models a host crash.
      process.kill(-child.pid, signal);
      await exit;
    }
    lines.close();
  };
  try {
    await until(() => {
      assert.equal(exited, false, logs);
      return ready !== undefined;
    }, "runtime startup");
  } catch (error) {
    await stop("SIGKILL");
    throw error;
  }
  return {
    stop,
    logs: () => logs,
    call: async (operation, id) => {
      const url = new URL(operation, ready);
      url.searchParams.set("id", id);
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.ok, true, await response.clone().text());
      return response.json();
    },
  };
}

for (const downtime of [0, 5_000]) {
  test(
    `${backend} workflow recovery after SIGKILL (${downtime} ms downtime)`,
    { timeout: 45_000 },
    async (t) => {
      const storage = await mkdtemp(join(tmpdir(), "executor-miniflare-recovery-"));
      const calls = new Map();
      const upstream = createServer((request, response) => {
        const key = request.url;
        const count = (calls.get(key) ?? 0) + 1;
        calls.set(key, count);
        if (key === "/active/work" && count === 1) return;
        response.writeHead(key === "/retry/work" && count === 1 ? 500 : 200, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ key, count }));
      });
      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");
      const address = upstream.address();
      assert.ok(address && typeof address === "object");
      const url = `http://127.0.0.1:${address.port}`;
      const ids = [
        "sleep",
        "until",
        "retry",
        "active",
        "timeout",
        "event",
        "paused",
        "terminated",
        "complete",
      ];
      let runtime;
      try {
        runtime = await startRuntime(storage, url);
        await Promise.all(ids.map((id) => runtime.call("/create", id)));
        await until(async () => {
          const statuses = await Promise.all(ids.map((id) => runtime.call("/status", id)));
          return (
            statuses.every((status) => status.__LOCAL_DEV_STEP_OUTPUTS.length >= 1) &&
            calls.get("/retry/work") === 1 &&
            calls.get("/active/work") === 1
          );
        }, "all first steps committed and interrupted work started");
        await runtime.call("/pause", "paused");
        await until(
          async () => (await runtime.call("/status", "paused")).status === "paused",
          "pause",
        );
        await runtime.call("/terminate", "terminated");
        // Allow the failed attempt to commit its retry deadline before the crash.
        await delay(150);
        await runtime.stop("SIGKILL");
        await delay(downtime);
        runtime = await startRuntime(storage, url);

        // Observe only the independent upstream: status polling must not wake runs.
        await until(
          () =>
            ["sleep", "until", "retry", "active", "timeout"].every(
              (id) => calls.get(`/${id}/last`) === 1,
            ),
          "automatic sleep, retry, active-step and event-timeout recovery",
        );
        await runtime.call("/event", "event");
        await until(() => calls.get("/event/last") === 1, "event delivery after recovery");
        for (const id of ids)
          assert.equal(calls.get(`/${id}/first`), 1, `${id}: completed step replayed`);
        assert.equal(calls.get("/retry/work"), 2, "failed attempt retried once");
        assert.equal(calls.get("/active/work"), 2, "interrupted attempt retried once");
        assert.equal(calls.has("/paused/last"), false);
        assert.equal(calls.has("/terminated/last"), false);
        assert.equal((await runtime.call("/status", "paused")).status, "paused");
        assert.equal((await runtime.call("/status", "terminated")).status, "terminated");
        assert.equal((await runtime.call("/status", "complete")).status, "complete");
        for (const id of ["sleep", "until", "retry", "active", "timeout", "event"]) {
          await until(
            async () => (await runtime.call("/status", id)).status === "complete",
            `${id}: completion`,
          );
          const first = { key: `/${id}/first`, count: 1 };
          assert.deepEqual(
            (await runtime.call("/status", id)).output,
            id === "timeout"
              ? { first, timeoutMessage: "Execution timed out after 4000ms" }
              : first,
          );
        }
        await runtime.call("/resume", "paused");
        await until(() => calls.get("/paused/last") === 1, "explicit resume of paused workflow");
        assert.equal(calls.get("/paused/first"), 1);
        t.diagnostic(
          "Sleep, retry, interrupted step, event timeout/delivery, pause/resume, termination, and saved results verified.",
        );
      } catch (error) {
        t.diagnostic(runtime?.logs() ?? "Runtime did not start");
        t.diagnostic(JSON.stringify(Object.fromEntries(calls)));
        if (runtime) {
          for (const id of ids) {
            try {
              t.diagnostic(JSON.stringify({ id, status: await runtime.call("/status", id) }));
            } catch {
              /* Keep the original failure if the crashed runtime is unavailable. */
            }
          }
        }
        throw error;
      } finally {
        await runtime?.stop();
        upstream.closeAllConnections();
        await new Promise((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(storage, { recursive: true, force: true });
      }
    },
  );
}

if (backend === "alchemy") {
  test(
    "Alchemy without containers releases every listener when its scope closes",
    { timeout: 20_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "executor-alchemy-lifecycle-"));
      const script = fileURLToPath(
        new URL("./fixtures/alchemy-runtime-lifecycle.mjs", import.meta.url),
      );
      const child = spawn(process.execPath, [script, directory], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      const exited = once(child, "exit");
      try {
        const [code] = await Promise.race([
          exited,
          delay(15_000, undefined, { ref: false }).then(() =>
            assert.fail("Runtime did not release its listeners: " + output),
          ),
        ]);
        assert.equal(code, 0, output);
        assert.match(output, /runtime closed/);
      } finally {
        if (child.exitCode === null) {
          process.kill(-child.pid, "SIGKILL");
          await exited;
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
