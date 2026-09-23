import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { Redacted, Schema } from "effect";
import { ServerReady } from "@executor-js/local-server/auth";
import { DesktopCallback, LocalOrigin } from "../src/contracts/desktop.ts";

// Exercise real HTTP, persistence, bootstrap and the private OAuth pipe together.
for (const dev of ["0", "1"])
  test(
    `desktop server pairs, relays callbacks through native routes, and closes (dev=${dev})`,
    { timeout: 60_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "executor-desktop-test-"));
      const token = "ab".repeat(32);
      const child = spawn(
        process.execPath,
        [new URL("../src/server.ts", import.meta.url).pathname],
        {
          env: {
            ...process.env,
            EXECUTOR_PORT: "0",
            EXECUTOR_DATA_DIR: directory,
            EXECUTOR_DESKTOP_DEV: dev,
            EXECUTOR_BROWSER_ORIGIN: undefined,
            EXECUTOR_API_KEY: "desktop-test-api-key-at-least-32-chars",
            EXECUTOR_ENCRYPTION_KEY: "12".repeat(32),
          },
          stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
        },
      );
      const exit = once(child, "exit");
      const bootstrap = child.stdio[3];
      const callbackPipe = child.stdio[4];
      assert.ok(bootstrap && "write" in bootstrap && "end" in bootstrap);
      assert.ok(callbackPipe && "read" in callbackPipe);
      assert.ok(child.stdout && child.stderr);
      child.stderr.resume();
      const readyLines = createInterface({ input: child.stdout });
      const callbackLines = createInterface({ input: callbackPipe });
      try {
        const readyLine = once(readyLines, "line");
        bootstrap.end(JSON.stringify({ version: 1, token }));
        const [line] = await Promise.race([
          readyLine,
          exit.then(() => {
            throw new Error("Desktop backend exited before readiness");
          }),
        ]);
        const { url } = Schema.decodeUnknownSync(Schema.fromJsonString(ServerReady))(line);
        Schema.decodeUnknownSync(LocalOrigin)(url);
        assert.equal(String(line).includes(token), false);
        assert.equal(
          (await (await fetch(`${url}/auth/session`, { headers: { origin: url } })).json())
            .authenticated,
          false,
        );
        const exchange = () =>
          fetch(`${url}/auth/exchange`, {
            method: "POST",
            headers: { origin: url, "content-type": "application/json" },
            body: JSON.stringify({ token }),
          });
        const paired = await exchange();
        assert.equal(paired.status, 200);
        const cookie = paired.headers.get("set-cookie")?.split(";")[0];
        assert.ok(cookie);
        assert.equal((await exchange()).status, 401);
        assert.equal(
          (await (await fetch(`${url}/auth/session`, { headers: { origin: url, cookie } })).json())
            .authenticated,
          true,
        );
        const page = await fetch(`${url}/apps`);
        assert.equal(page.status, 200);
        assert.match(await page.text(), dev === "1" ? /<script/ : /id="root"/);
        assert.equal(
          (await fetch(`${url}/auth/not-a-route`, { headers: { accept: "text/html" } })).status,
          404,
        );
        if (dev === "1") {
          const vite = await fetch(`${url}/bundledDevClient.mjs`);
          assert.equal(vite.status, 200);
          assert.match(vite.headers.get("content-type") ?? "", /javascript/);
        }
        const head = await fetch(`${url}/api/oauth/callback?state=ignored`, { method: "HEAD" });
        assert.equal(head.status, 200);
        assert.equal(await head.text(), "");
        assert.equal((await fetch(`${url}/api/oauth/callback?code=missing-state`)).status, 400);
        const callbackLine = once(callbackLines, "line");
        const callback = `${url}/api/oauth/callback?state=test-state&code=test-code`;
        const response = await fetch(callback);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const html = await response.text();
        assert.match(html, /Return to Executor/);
        assert.equal(html.includes("test-code"), false);
        const [message] = await callbackLine;
        assert.equal(
          Redacted.value(
            Schema.decodeUnknownSync(Schema.fromJsonString(DesktopCallback))(message).url,
          ),
          callback,
        );
        const rendered = await fetch(callback, {
          headers: { "x-executor-desktop-return": "1", cookie },
        });
        assert.match(await rendered.text(), dev === "1" ? /<script/ : /id="root"/);
        child.kill("SIGTERM");
        const [code] = await exit;
        assert.equal(code, 130);
        await assert.rejects(fetch(`${url}/auth/session`));
      } finally {
        readyLines.close();
        callbackLines.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exit;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
