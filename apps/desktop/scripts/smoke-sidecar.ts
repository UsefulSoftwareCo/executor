/**
 * End-to-end smoke test for the bundled executor binary.
 *
 * Catches "works in dev, breaks in --compile" regressions: bunfs asset
 * loading (embedded web UI, QuickJS WASM), native
 * .node loaders (keychain), and the MCP → engine → QuickJS → tool path.
 *
 * Flow:
 *   1. Spin up a tiny local OpenAPI server (one operation, returns 42).
 *   2. Spawn the compiled `executor daemon run --foreground --port 0`
 *      and parse the ready URL.
 *   3. Connect via MCP streamable HTTP, call the `execute` tool with code
 *      that registers and invokes the OpenAPI tool, assert the answer
 *      round-trips as 42.
 *
 * Run after `bun ./scripts/build-sidecar.ts`. Exits non-zero on any
 * deviation so it can gate CI.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn, type Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = resolve(import.meta.dir, "..");
const APPS_LOCAL_DRIZZLE = resolve(ROOT, "../local/drizzle-legacy-v1");
const BINARY = resolve(
  ROOT,
  "resources/executor",
  process.platform === "win32" ? "executor.exe" : "executor",
);

const AUTH_TOKEN = "smoke-test-token";
const AUTH_HEADER = `Bearer ${AUTH_TOKEN}`;
const READY_TIMEOUT_MS = 30_000;

// Throw instead of process.exit so main()'s finally still tears down the
// spawned daemon + temp dirs — exiting here leaks a running process.
const fail = (msg: string): never => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: standalone smoke harness surfaces failures as a thrown error
  throw new Error(`[smoke-sidecar] FAIL: ${msg}`);
};

type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const makeScopeId = (cwd: string): string => {
  const folder = basename(cwd) || cwd;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${folder}-${hash}`;
};

const readLegacyMigrations = async (): Promise<readonly { sql: string; hash: string }[]> => {
  const journal = (await Bun.file(join(APPS_LOCAL_DRIZZLE, "meta/_journal.json")).json()) as {
    readonly entries: readonly { readonly idx: number; readonly tag: string }[];
  };

  const migrations: { sql: string; hash: string }[] = [];
  for (const entry of [...journal.entries].sort((left, right) => left.idx - right.idx)) {
    const query = await Bun.file(join(APPS_LOCAL_DRIZZLE, `${entry.tag}.sql`)).text();
    migrations.push({
      sql: query,
      hash: createHash("sha256").update(query).digest("hex"),
    });
  }
  return migrations;
};

const seedLegacyScopedSqlite = async (dataDir: string, scopeId: string): Promise<void> => {
  const db = new Database(join(dataDir, "data.db"));
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: standalone smoke harness closes the SQLite handle before spawning the sidecar
  try {
    // Replay the real legacy v1 chain so the fixture matches the migration
    // history the sidecar's embedded copy expects. A hand-rolled partial
    // schema that claims the full history is applied makes the v1→v2 data
    // migration read tables that don't exist.
    const migrations = await readLegacyMigrations();
    for (const migration of migrations) {
      // `--> statement-breakpoint` markers are SQL line comments, so the
      // whole file executes as one multi-statement batch.
      db.exec(migration.sql);
    }

    db.exec(`
      CREATE TABLE "__drizzle_migrations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        hash text NOT NULL,
        created_at numeric
      );
    `);
    const insertMigration = db.prepare(
      `INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)`,
    );
    for (const migration of migrations) {
      insertMigration.run(migration.hash, Date.now());
    }

    db.prepare(
      `INSERT INTO source (
        scope_id, id, plugin_id, kind, name, url, can_remove, can_refresh, can_edit, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      scopeId,
      "legacy-smoke",
      "smoke",
      "remote",
      "Legacy Smoke Source",
      null,
      1,
      0,
      1,
      1_700_000_000_000,
      1_700_000_001_000,
    );
    db.prepare("INSERT INTO blob (namespace, key, value) VALUES (?, ?, ?)").run(
      `${scopeId}/smoke`,
      "legacy",
      "{}",
    );
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
  } finally {
    db.close();
  }
};

// The v1→v2 migration moves the legacy SQLite file set aside as
// `data.db.v1-v2-<ts>-<nonce>` before writing the new v2 database. Assert the
// backup exists and still holds the seeded legacy row — that proves the
// migration path ran (rather than the sidecar treating the DB as fresh) and
// preserved the original data.
const assertV1MigrationCompleted = async (dataDir: string): Promise<void> => {
  const entries = await Array.fromAsync(new Bun.Glob("data.db.v1-v2-*").scan({ cwd: dataDir }));
  const backups = entries.filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm"));
  if (backups.length !== 1) {
    fail(`expected exactly one v1→v2 backup in ${dataDir}, found: ${JSON.stringify(entries)}`);
  }

  const backup = new Database(join(dataDir, backups[0]!), { readonly: true });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: standalone smoke harness closes the SQLite handle it opened
  try {
    const row = backup.prepare("SELECT name FROM source WHERE id = 'legacy-smoke'").get() as {
      name?: string;
    } | null;
    if (row?.name !== "Legacy Smoke Source") {
      fail(`v1→v2 backup is missing the seeded legacy source row: ${JSON.stringify(row)}`);
    }
  } finally {
    backup.close();
  }
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
      rejectReady(new Error(`daemon did not announce ready within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);

    let stdoutBuf = "";
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();

    const stderrReader = proc.stderr.getReader();
    void (async () => {
      while (true) {
        const { value, done } = await stderrReader.read();
        if (done) return;
        process.stderr.write(`[executor-stderr] ${decoder.decode(value)}`);
      }
    })();

    void (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          clearTimeout(deadline);
          // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: standalone smoke harness, stdout-closed surfaced as rejection
          rejectReady(new Error("daemon stdout closed before ready"));
          return;
        }
        const chunk = decoder.decode(value);
        process.stdout.write(`[executor-stdout] ${chunk}`);
        stdoutBuf += chunk;
        const match = /Daemon ready on http:\/\/(?:\[[^\]]+\]|[^:\s]+):(\d+)/.exec(stdoutBuf);
        if (match) {
          clearTimeout(deadline);
          resolveReady(parseInt(match[1]!, 10));
          return;
        }
      }
    })();
  });

const completePausedResult = async (
  client: Client,
  initial: ToolCallResult,
): Promise<Record<string, unknown>> => {
  let result = initial;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (result.isError) {
      fail(`tool returned isError: ${JSON.stringify(result.content)}`);
    }

    const structured = result.structuredContent;
    if (!isRecord(structured)) {
      fail(`tool returned no structured content: ${JSON.stringify(result.content)}`);
    }
    const structuredRecord = structured as Record<string, unknown>;

    if (structuredRecord.status !== "waiting_for_interaction") {
      return structuredRecord;
    }

    const executionId = structuredRecord.executionId;
    if (typeof executionId !== "string" || executionId.length === 0) {
      fail(`paused result missing executionId: ${JSON.stringify(structuredRecord)}`);
    }

    console.log(`[smoke-sidecar] auto-accepting paused execution ${executionId}`);
    result = await client.callTool({
      name: "resume",
      arguments: { executionId, action: "accept", content: "{}" },
    });
  }

  return fail("execute still paused after 5 resume attempts");
};

const main = async () => {
  if (!(await Bun.file(BINARY).exists())) {
    fail(
      `binary not found at ${BINARY}. Run \`bun ./scripts/build-sidecar.ts\` from apps/desktop first.`,
    );
  }

  const scopeDir = await mkdtemp(join(tmpdir(), "executor-smoke-scope-"));
  const dataDir = await mkdtemp(join(tmpdir(), "executor-smoke-data-"));
  await seedLegacyScopedSqlite(dataDir, makeScopeId(scopeDir));
  // v2 connections reference credentials by provider item instead of carrying
  // raw values, so seed the file-secrets provider (auth.json under
  // XDG_DATA_HOME) with the token the sandbox's connections.create points at.
  const xdgDir = await mkdtemp(join(tmpdir(), "executor-smoke-xdg-"));
  await Bun.write(
    join(xdgDir, "executor", "auth.json"),
    `${JSON.stringify({ "petstore-token": "smoke-token" })}\n`,
  );
  const openapi = startOpenApiServer();

  console.log(`[smoke-sidecar] scope:   ${scopeDir}`);
  console.log(`[smoke-sidecar] data:    ${dataDir}`);
  console.log(`[smoke-sidecar] openapi: ${openapi.origin}`);

  const proc = spawn({
    cmd: [
      BINARY,
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
      EXECUTOR_SCOPE_DIR: scopeDir,
      EXECUTOR_DATA_DIR: dataDir,
      EXECUTOR_CLIENT: "desktop",
      XDG_DATA_HOME: xdgDir,
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
    // oxlint-disable-next-line executor/no-promise-catch -- boundary: best-effort tempdir cleanup in a standalone smoke harness
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    // oxlint-disable-next-line executor/no-promise-catch -- boundary: best-effort tempdir cleanup in a standalone smoke harness
    await rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  };

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: standalone smoke harness needs a finally to tear down the spawned binary + http server
  try {
    const port = await waitForReadyPort(proc);
    await assertV1MigrationCompleted(dataDir);
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
    const hasResume = tools.tools.some((t) => t.name === "resume");
    if (!hasResume) fail(`MCP tools/list missing "resume": ${JSON.stringify(tools.tools)}`);

    // Shared sandbox helper, prepended to both execute calls.
    const unwrapHelper = `
const unwrapToolData = (value) => {
  if (value && typeof value === "object" && "ok" in value) {
    if (!value.ok) throw new Error(value.error?.message ?? "Tool failed");
    value = value.data;
  }
  if (value && typeof value === "object" && "data" in value) return value.data;
  return value;
};
`;

    // Execute #1 — register the integration and create its connection. v2
    // produces tools per connection, and the sandbox snapshots the tool tree
    // when an execution starts, so the invocation has to happen in a second
    // execute call.
    const setupCode = `${unwrapHelper}
unwrapToolData(await tools.executor.openapi.addSpec({
  spec: { kind: "url", url: ${JSON.stringify(`${openapi.origin}/openapi.json`)} },
  baseUrl: ${JSON.stringify(openapi.origin)},
  slug: "petstore",
}));
unwrapToolData(await tools.executor.coreTools.connections.create({
  owner: "org",
  name: "main",
  integration: "petstore",
  template: "apiKey",
  from: { provider: "file", id: "petstore-token" },
}));
return "setup-ok";
`;

    const setupResult = await completePausedResult(
      client,
      await client.callTool({
        name: "execute",
        arguments: { code: setupCode },
      }),
    );
    if (setupResult.result !== "setup-ok") {
      fail(`integration setup failed: ${JSON.stringify(setupResult)}`);
    }

    // Execute #2 — drive the running OpenAPI server. Covers per-connection
    // tool registration, array list response, path param dispatch, and object
    // responses — all going out over real HTTP from inside QuickJS, via the
    // v2 `tools.<integration>.<owner>.<connection>.<tool>` address.
    const invokeCode = `${unwrapHelper}
const list = unwrapToolData(await tools.petstore.org.main.pets.listPets({}));
const fetchedData = unwrapToolData(await tools.petstore.org.main.pets.getPet({ petId: list[1].id }));
return {
  count: list.length,
  names: list.map((p) => p.name),
  fetched: { id: fetchedData.id, name: fetchedData.name },
};
`;

    const result = await client.callTool({
      name: "execute",
      arguments: { code: invokeCode },
    });
    const structured = await completePausedResult(client, result);
    const expected = {
      count: 2,
      names: ["Fido", "Whiskers"],
      fetched: { id: 2, name: "Whiskers" },
    };
    if (JSON.stringify(structured.result) !== JSON.stringify(expected)) {
      fail(
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(structured.result)} (content: ${JSON.stringify(result.content)})`,
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
