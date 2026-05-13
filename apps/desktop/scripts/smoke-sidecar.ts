/**
 * End-to-end smoke test for the compiled sidecar binary.
 *
 * Catches "works in dev, breaks in --compile" regressions: bunfs asset
 * loading (QuickJS WASM, embedded migrations, embedded web UI), native
 * .node loaders (keychain), and the MCP → engine → QuickJS → tool path.
 *
 * Flow:
 *   1. Spin up a tiny local OpenAPI server (one operation, returns 42).
 *   2. Spawn the compiled `executor-sidecar` binary with EXECUTOR_PORT=0
 *      and parse the `EXECUTOR_READY:<port>` sentinel.
 *   3. Connect via MCP streamable HTTP, call the `execute` tool with code
 *      that registers and invokes the OpenAPI tool, assert the answer
 *      round-trips as 42.
 *
 * Run after `bun ./scripts/build-sidecar.ts`. Exits non-zero on any
 * deviation so it can gate CI.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type Subprocess } from "bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = resolve(import.meta.dir, "..");
const BINARY = resolve(
  ROOT,
  "resources/sidecar",
  process.platform === "win32" ? "executor-sidecar.exe" : "executor-sidecar",
);

const AUTH_PASSWORD = "smoke-test-password";
const AUTH_HEADER = `Basic ${btoa(`executor:${AUTH_PASSWORD}`)}`;
const READY_TIMEOUT_MS = 30_000;

const fail = (msg: string): never => {
  console.error(`[smoke-sidecar] FAIL: ${msg}`);
  process.exit(1);
};

// Petstore-style spec: GET list + GET by id. Exercises path params,
// multi-step orchestration, and array/object response shapes against a real
// running HTTP server, all the way through the compiled binary →
// MCP → QuickJS → openapi-invoker → HttpClient chain.
const startOpenApiServer = () => {
  const Pet = {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      tag: { type: "string" },
    },
    required: ["id", "name"],
  };

  const spec = {
    openapi: "3.0.0",
    info: { title: "Petstore Smoke API", version: "0.0.1" },
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { type: "array", items: Pet } },
              },
            },
          },
        },
      },
      "/pets/{petId}": {
        get: {
          operationId: "getPet",
          parameters: [
            {
              name: "petId",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: Pet } },
            },
            "404": { description: "not found" },
          },
        },
      },
    },
  };

  // Seed the in-memory store so the GET-driven smoke can verify list +
  // path-param round-trips. Body-bearing POST/PUT is gated by the
  // executor's approval flow and is covered by separate non-compiled tests.
  const pets: Array<{ id: number; name: string; tag?: string }> = [
    { id: 1, name: "Fido", tag: "dog" },
    { id: 2, name: "Whiskers", tag: "cat" },
  ];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/openapi.json") return Response.json(spec);

      if (url.pathname === "/pets" && req.method === "GET") {
        return Response.json(pets);
      }

      const match = /^\/pets\/(\d+)$/.exec(url.pathname);
      if (match && req.method === "GET") {
        const pet = pets.find((p) => p.id === Number(match[1]));
        if (!pet) return new Response("not found", { status: 404 });
        return Response.json(pet);
      }

      return new Response("not found", { status: 404 });
    },
  });
  return { server, origin: `http://127.0.0.1:${server.port}` };
};

const waitForReadyPort = (proc: Subprocess<"ignore", "pipe", "pipe">): Promise<number> =>
  // oxlint-disable-next-line executor/no-promise-reject -- boundary: standalone build-time smoke harness, no Effect runtime
  new Promise((resolveReady, rejectReady) => {
    const deadline = setTimeout(() => {
      // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: standalone smoke harness reporting a build-time timeout
      rejectReady(new Error(`sidecar did not announce ready within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);

    let stdoutBuf = "";
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();

    const stderrReader = proc.stderr.getReader();
    void (async () => {
      while (true) {
        const { value, done } = await stderrReader.read();
        if (done) return;
        process.stderr.write(`[sidecar-stderr] ${decoder.decode(value)}`);
      }
    })();

    void (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          clearTimeout(deadline);
          // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: standalone smoke harness, stdout-closed surfaced as rejection
          rejectReady(new Error("sidecar stdout closed before ready"));
          return;
        }
        const chunk = decoder.decode(value);
        process.stdout.write(`[sidecar-stdout] ${chunk}`);
        stdoutBuf += chunk;
        const match = /EXECUTOR_READY:(\d+)/.exec(stdoutBuf);
        if (match) {
          clearTimeout(deadline);
          resolveReady(parseInt(match[1]!, 10));
          return;
        }
      }
    })();
  });

const main = async () => {
  if (!(await Bun.file(BINARY).exists())) {
    fail(
      `binary not found at ${BINARY}. Run \`bun ./scripts/build-sidecar.ts\` from apps/desktop first.`,
    );
  }

  const scopeDir = await mkdtemp(join(tmpdir(), "executor-smoke-"));
  const openapi = startOpenApiServer();

  console.log(`[smoke-sidecar] scope:   ${scopeDir}`);
  console.log(`[smoke-sidecar] openapi: ${openapi.origin}`);

  const proc = spawn({
    cmd: [BINARY],
    env: {
      ...process.env,
      EXECUTOR_PORT: "0",
      EXECUTOR_HOST: "127.0.0.1",
      EXECUTOR_AUTH_PASSWORD: AUTH_PASSWORD,
      EXECUTOR_SCOPE_DIR: scopeDir,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let exitCode: number | null = null;
  void proc.exited.then((code) => {
    exitCode = code;
  });

  const cleanup = async () => {
    if (exitCode === null) {
      proc.kill("SIGTERM");
      await Promise.race([proc.exited, Bun.sleep(3000)]);
      if (exitCode === null) proc.kill("SIGKILL");
    }
    openapi.server.stop(true);
    // oxlint-disable-next-line executor/no-promise-catch -- boundary: best-effort tempdir cleanup in a standalone smoke harness
    await rm(scopeDir, { recursive: true, force: true }).catch(() => {});
  };

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: standalone smoke harness needs a finally to tear down the spawned binary + http server
  try {
    const port = await waitForReadyPort(proc);
    const mcpUrl = new URL(`http://127.0.0.1:${port}/mcp`);
    console.log(`[smoke-sidecar] ready on ${mcpUrl.origin}`);

    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { Authorization: AUTH_HEADER } },
    });
    const client = new Client({ name: "smoke-test", version: "0.0.1" });
    await client.connect(transport);

    const tools = await client.listTools();
    const hasExecute = tools.tools.some((t) => t.name === "execute");
    if (!hasExecute) fail(`MCP tools/list missing "execute": ${JSON.stringify(tools.tools)}`);

    // Drive the running OpenAPI server through a multi-step orchestration
    // in one execute. Covers: source registration, array list response, path
    // param dispatch, and object responses — all going out over real HTTP from
    // inside QuickJS.
    const code = `
await tools.executor.openapi.addSource({
  scope: ${JSON.stringify(scopeDir)},
  spec: ${JSON.stringify(`${openapi.origin}/openapi.json`)},
  baseUrl: ${JSON.stringify(openapi.origin)},
  namespace: "petstore",
});
const list = await tools.petstore.pets.listPets({});
const fetched = await tools.petstore.pets.getPet({ petId: list[1].id });
return {
  count: list.length,
  names: list.map((p) => p.name),
  fetched: { id: fetched.id, name: fetched.name },
};
`;

    const result = await client.callTool({ name: "execute", arguments: { code } });
    if (result.isError) {
      fail(`execute returned isError: ${JSON.stringify(result.content)}`);
    }
    const structured = result.structuredContent as { result?: unknown } | undefined;
    const expected = {
      count: 2,
      names: ["Fido", "Whiskers"],
      fetched: { id: 2, name: "Whiskers" },
    };
    if (JSON.stringify(structured?.result) !== JSON.stringify(expected)) {
      fail(
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(structured?.result)} (content: ${JSON.stringify(result.content)})`,
      );
    }

    await client.close();
    console.log(
      `[smoke-sidecar] OK — listPets + getPet({petId:2}) round-tripped through the running OpenAPI server`,
    );
  } finally {
    await cleanup();
  }
};

await main();
