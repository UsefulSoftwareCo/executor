/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-promise-reject, executor/no-promise-catch -- boundary: standalone build smoke harness tears down a spawned packed binary */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type Subprocess } from "bun";

const binary = process.argv[2];
if (!binary) throw new Error("usage: bun apps/cli/scripts/smoke-packed-apps.ts <packed-binary>");

const AUTH_TOKEN = "packed-apps-smoke-token";
const READY_TIMEOUT_MS = 45_000;

const fail = (message: string): never => {
  throw new Error(`[smoke-packed-apps] FAIL: ${message}`);
};

const requestJson = async <T>(origin: string, path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(new URL(path, origin), {
    ...init,
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) fail(`${init.method ?? "GET"} ${path} returned ${response.status}: ${text}`);
  return (text.length > 0 ? JSON.parse(text) : null) as T;
};

const waitForReadyPort = async (proc: Subprocess<"ignore", "pipe", "pipe">): Promise<number> =>
  new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error("packed binary did not report ready in time")),
      READY_TIMEOUT_MS,
    );
    let stdout = "";
    let stderr = "";
    const finish = (result: number | Error): void => {
      clearTimeout(timer);
      if (result instanceof Error) rejectReady(result);
      else resolveReady(result);
    };
    void proc.exited.then((code) => {
      finish(new Error(`packed binary exited before ready with code ${code}: ${stderr}`));
    });
    void (async () => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          stdout += decoder.decode(chunk.value);
          const match = stdout.match(/EXECUTOR_READY:(\d+)/);
          if (match) {
            finish(Number(match[1]));
            return;
          }
        }
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error(String(cause)));
      }
    })();
    void (async () => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        stderr += decoder.decode(chunk.value);
      }
    })().catch(() => undefined);
  });

const main = async (): Promise<void> => {
  const fixture = await mkdtemp(join(tmpdir(), "executor-packed-apps-fixture-"));
  const dataDir = await mkdtemp(join(tmpdir(), "executor-packed-apps-data-"));
  const scopeDir = await mkdtemp(join(tmpdir(), "executor-packed-apps-scope-"));
  let proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  try {
    await mkdir(join(fixture, "tools"), { recursive: true });
    await writeFile(
      join(fixture, "tools", "greet.ts"),
      `
        import { z } from "zod";
        import { defineTool } from "executor:app";

        const Input = z.object({ name: z.string() });

        export default defineTool({
          description: "Greet",
          input: Input,
          async handler(input) {
            return { greeting: "hello " + input.name };
          },
        });
      `,
    );
    await writeFile(
      join(fixture, "package.json"),
      `${JSON.stringify({ name: "packed-apps-smoke", dependencies: { zod: "4.3.6" } })}\n`,
    );
    await writeFile(join(fixture, "bun.lock"), "");

    proc = spawn({
      cmd: [
        resolve(binary),
        "daemon",
        "run",
        "--foreground",
        "--port",
        "0",
        "--hostname",
        "127.0.0.1",
        "--auth-token",
        AUTH_TOKEN,
      ],
      env: {
        ...process.env,
        EXECUTOR_CLIENT: "desktop",
        EXECUTOR_DATA_DIR: dataDir,
        EXECUTOR_SCOPE_DIR: scopeDir,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const port = await waitForReadyPort(proc);
    const origin = `http://127.0.0.1:${port}`;
    console.log(`[smoke-packed-apps] ready on ${origin}`);

    await requestJson(origin, "/api/apps/sources", {
      method: "POST",
      body: JSON.stringify({
        kind: "local-directory",
        slug: "packed-apps-smoke",
        app: "packed-apps-smoke",
        path: fixture,
      }),
    });

    const sync = await requestJson<{
      readonly status: string;
      readonly tools: readonly string[];
      readonly errors?: readonly unknown[];
    }>(origin, "/api/apps/sources/packed-apps-smoke/sync", { method: "POST" });
    if (sync.status !== "published") fail(`sync failed: ${JSON.stringify(sync.errors)}`);
    if (JSON.stringify(sync.tools) !== JSON.stringify(["greet"])) {
      fail(`expected greet tool, got ${JSON.stringify(sync.tools)}`);
    }

    const invoked = await requestJson<{
      readonly status: string;
      readonly structured: unknown;
      readonly isError: boolean;
      readonly text: string;
    }>(origin, "/api/executions", {
      method: "POST",
      body: JSON.stringify({
        code: `export default await tools["packed-apps-smoke.org.published.greet"]({ name: "Ada" })`,
        autoApprove: true,
      }),
    });
    if (invoked.status !== "completed" || invoked.isError) {
      fail(`execution failed: ${JSON.stringify(invoked)}`);
    }
    if (
      JSON.stringify(invoked.structured) !==
      JSON.stringify({
        status: "completed",
        result: { ok: true, data: { greeting: "hello Ada" } },
        logs: [],
      })
    ) {
      fail(`unexpected execution result: ${JSON.stringify(invoked)}`);
    }
    console.log("[smoke-packed-apps] OK - local-directory app source bundled and invoked");
  } finally {
    if (proc) {
      proc.kill("SIGTERM");
      await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      proc.kill("SIGKILL");
    }
    await rm(fixture, { recursive: true, force: true }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(scopeDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

await main();
