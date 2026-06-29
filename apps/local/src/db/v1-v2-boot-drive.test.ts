// ---------------------------------------------------------------------------
// Full-boot stress drive: the REAL local executor stack (v1 gate → fumadb
// DDL → data-migration ledger → createExecutor) booted repeatedly over
// databases in every migration state, then exercised with real work — a
// live OpenAPI spec added through executor.openapi.addSpec, a connection
// created, and tools invoked against a real HTTP server. Each scenario then
// REBOOTS the same database file and proves everything still works: the
// definitive check that migrations converge and never eat data.
//
// This is the test the 2026-06-11 desktop crash was missing: the sidecar
// died inside the v1 gate before any request could be served, on a database
// state no unit test had seeded.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

import { collectTables } from "@executor-js/api/server";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  Subject,
  Tenant,
  ToolAddress,
  createExecutor,
  isToolResult,
  runSqliteDataMigrations,
} from "@executor-js/sdk";
import { memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import { openApiPlugin } from "@executor-js/plugin-openapi";
import { serveOpenApiHttpApiTestServer } from "@executor-js/plugin-openapi/testing";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";

import { executeSql, openLocalLibsql, queryRows } from "./libsql";
import { localDataMigrations } from "./data-migrations";
import { migrateLocalV1ToV2IfNeeded } from "./v1-v2-migration";
import { createSqliteFumaDb } from "./sqlite-fumadb";

const TENANT = "executor-workspace-drive77";
const legacyDir = join(import.meta.dirname, "../../drizzle-legacy-v1");

let workDir: string;
let previousXdgDataHome: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "executor-v1v2-drive-"));
  previousXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(workDir, "xdg");
});

afterEach(() => {
  if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdgDataHome;
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A real API to migrate against and call after boot.
// ---------------------------------------------------------------------------

const Widget = Schema.Struct({ id: Schema.Number, name: Schema.String });

const WidgetsGroup = HttpApiGroup.make("widgets")
  .add(HttpApiEndpoint.get("listWidgets", "/widgets", { success: Schema.Array(Widget) }))
  .add(
    HttpApiEndpoint.post("createWidget", "/widgets", {
      payload: Schema.Struct({ name: Schema.String }),
      success: Widget,
    }),
  );

const DriveApi = HttpApi.make("driveApi").add(WidgetsGroup);

const WIDGETS = [
  { id: 1, name: "flux capacitor" },
  { id: 2, name: "sprocket" },
];

const WidgetsLive = HttpApiBuilder.group(DriveApi, "widgets", (handlers) =>
  handlers
    .handle("listWidgets", () => Effect.succeed(WIDGETS.map((w) => Widget.make(w))))
    .handle("createWidget", (req) =>
      Effect.succeed(Widget.make({ id: WIDGETS.length + 1, name: req.payload.name })),
    ),
);

// ---------------------------------------------------------------------------
// Boot the real local stack over a database file. Mirrors
// apps/local/src/executor.ts's createLocalExecutorLayer (gate → DDL →
// ledger → createExecutor) with test-friendly plugins.
// ---------------------------------------------------------------------------

const bootRealStack = async (dbPath: string) => {
  const migration = await migrateLocalV1ToV2IfNeeded({
    sqlitePath: dbPath,
    tables: collectTables(),
    namespace: "executor_local",
    tenantId: TENANT,
  });
  const sqlite = await createSqliteFumaDb({
    tables: collectTables(),
    namespace: "executor_local",
    path: dbPath,
  });
  await Effect.runPromise(runSqliteDataMigrations(sqlite.client, localDataMigrations));
  const executor = await Effect.runPromise(
    createExecutor({
      tenant: Tenant.make(TENANT),
      subject: Subject.make("local"),
      db: sqlite.db,
      plugins: [
        openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
        fileSecretsPlugin({ directory: join(workDir, "secrets") }),
        memoryCredentialsPlugin(),
      ] as const,
      onElicitation: "accept-all",
    }),
  );
  return {
    migration,
    executor,
    client: sqlite.client,
    dispose: async () => {
      await Effect.runPromise(Effect.ignore(executor.close()));
      await sqlite.close();
    },
  };
};

/** Seed a REAL v1-final database via the frozen legacy chain, with an mcp
 *  source the migration must carry over. */
const seedV1Final = async (dbPath: string, options?: { wipeJournal?: boolean }) => {
  const client = await openLocalLibsql(dbPath);
  await migrate(drizzle({ client }), { migrationsFolder: legacyDir });
  const now = Date.now();
  await executeSql(
    client,
    "INSERT INTO source (id, scope_id, plugin_id, kind, name, url, can_remove, can_refresh, can_edit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)",
    ["context7", TENANT, "mcp", "mcp", "Context7", "https://mcp.context7.com/mcp", now, now],
  );
  await executeSql(
    client,
    "INSERT INTO plugin_storage (id, scope_id, plugin_id, collection, key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "mcp-source-context7",
      TENANT,
      "mcp",
      "source",
      "context7",
      JSON.stringify({
        config: { transport: "remote", endpoint: "https://mcp.context7.com/mcp" },
      }),
      now,
      now,
    ],
  );
  if (options?.wipeJournal) await executeSql(client, "DELETE FROM __drizzle_migrations");
  client.close();
};

/** addSpec + connection + live invocation through the booted executor. */
const driveOpenApiWork = (
  stack: Awaited<ReturnType<typeof bootRealStack>>,
  server: { readonly specJson: string },
  slug: string,
) =>
  Effect.gen(function* () {
    const added = yield* stack.executor.openapi.addSpec({
      spec: { kind: "blob", value: server.specJson },
      slug,
      authenticationTemplate: [
        {
          slug: AuthTemplateSlug.make("apiKey"),
          type: "apiKey",
          headers: { "x-api-key": [{ type: "variable" as const, name: "token" }] },
        },
      ],
    });
    expect(added.toolCount).toBeGreaterThanOrEqual(2);

    yield* stack.executor.connections.create({
      owner: "org",
      name: ConnectionName.make("main"),
      integration: IntegrationSlug.make(slug),
      template: AuthTemplateSlug.make("apiKey"),
      value: "test-key-123",
    });

    const list = yield* stack.executor.execute(
      ToolAddress.make(`tools.${slug}.org.main.widgets.listWidgets`),
      {},
    );
    expect(isToolResult(list) && list.ok).toBe(true);
    if (!isToolResult(list) || !list.ok) return;
    // Payload-first contract holds through a migrated database too.
    expect(list.data).toEqual(WIDGETS);
    expect((list as { http?: { status: number } }).http?.status).toBe(200);

    const created = yield* stack.executor.execute(
      ToolAddress.make(`tools.${slug}.org.main.widgets.createWidget`),
      { body: { name: "doodad" } },
    );
    expect(isToolResult(created) && created.ok).toBe(true);
    if (!isToolResult(created) || !created.ok) return;
    expect(created.data).toEqual({ id: 3, name: "doodad" });
  });

const expectToolRows = async (dbPath: string, slug: string, minCount: number) => {
  const client = await openLocalLibsql(dbPath);
  const rows = await queryRows<{ n: number }>(
    client,
    "SELECT COUNT(*) AS n FROM tool WHERE integration = ?",
    [slug],
  );
  expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(minCount);
  client.close();
};

describe("full-boot drive across migration states", () => {
  it.effect("fresh database: boot → add spec → invoke → reboot → invoke again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dbPath = join(workDir, "fresh.db");
        const server = yield* serveOpenApiHttpApiTestServer({
          api: DriveApi,
          handlersLayer: WidgetsLive,
        });

        // Boot 1: fresh file, everything from zero.
        const stack1 = yield* Effect.promise(() => bootRealStack(dbPath));
        expect(stack1.migration.migrated).toBe(false);
        yield* driveOpenApiWork(stack1, server, "drive_api");
        yield* Effect.promise(() => stack1.dispose());

        // Boot 2: same file. Gate short-circuits via stamp, ledger no-ops,
        // and the persisted connection + tools still invoke live.
        const stack2 = yield* Effect.promise(() => bootRealStack(dbPath));
        expect(stack2.migration.migrated).toBe(false);
        const again = yield* stack2.executor.execute(
          ToolAddress.make("tools.drive_api.org.main.widgets.listWidgets"),
          {},
        );
        expect(isToolResult(again) && again.ok).toBe(true);
        if (!isToolResult(again) || !again.ok) return;
        expect(again.data).toEqual(WIDGETS);
        yield* Effect.promise(() => stack2.dispose());

        yield* Effect.promise(() => expectToolRows(dbPath, "drive_api", 2));
      }),
    ),
  );

  it.effect("v1-final database: migrate → carried data present → new work → reboot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dbPath = join(workDir, "v1.db");
        yield* Effect.promise(() => seedV1Final(dbPath));
        const server = yield* serveOpenApiHttpApiTestServer({
          api: DriveApi,
          handlersLayer: WidgetsLive,
        });

        // Boot 1: the v1 gate migrates, then the SAME boot does real work.
        const stack1 = yield* Effect.promise(() => bootRealStack(dbPath));
        expect(stack1.migration.migrated).toBe(true);
        const integrations = yield* stack1.executor.integrations.list();
        expect(integrations.map((i) => String(i.slug))).toContain("context7");
        yield* driveOpenApiWork(stack1, server, "drive_api");
        yield* Effect.promise(() => stack1.dispose());

        // Boot 2: nothing re-migrates; migrated v1 data AND post-migration
        // work both survive.
        const stack2 = yield* Effect.promise(() => bootRealStack(dbPath));
        expect(stack2.migration.migrated).toBe(false);
        const integrations2 = yield* stack2.executor.integrations.list();
        const slugs = integrations2.map((i) => String(i.slug));
        expect(slugs).toContain("context7");
        expect(slugs).toContain("drive_api");
        yield* Effect.promise(() => stack2.dispose());
      }),
    ),
  );

  it.effect(
    "the crash-state database (v1-final, empty journal): boots, migrates, drives work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dbPath = join(workDir, "crash.db");
          yield* Effect.promise(() => seedV1Final(dbPath, { wipeJournal: true }));
          const server = yield* serveOpenApiHttpApiTestServer({
            api: DriveApi,
            handlersLayer: WidgetsLive,
          });

          // Pre-fix: this boot threw `table blob already exists`.
          const stack = yield* Effect.promise(() => bootRealStack(dbPath));
          expect(stack.migration.migrated).toBe(true);
          yield* driveOpenApiWork(stack, server, "drive_api");
          yield* Effect.promise(() => stack.dispose());

          const reboot = yield* Effect.promise(() => bootRealStack(dbPath));
          expect(reboot.migration.migrated).toBe(false);
          yield* Effect.promise(() => reboot.dispose());
        }),
      ),
  );

  it.effect("five consecutive reboots of a migrated database are all no-ops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dbPath = join(workDir, "loop.db");
        yield* Effect.promise(() => seedV1Final(dbPath));

        const first = yield* Effect.promise(() => bootRealStack(dbPath));
        expect(first.migration.migrated).toBe(true);
        yield* Effect.promise(() => first.dispose());

        for (let i = 0; i < 5; i++) {
          const stack = yield* Effect.promise(() => bootRealStack(dbPath));
          expect(stack.migration.migrated).toBe(false);
          expect(stack.migration.warnings).toEqual([]);
          yield* Effect.promise(() => stack.dispose());
        }

        // Exactly one backup file set was created (the real migration), not
        // one per boot.
        const { readdirSync } = yield* Effect.promise(() => import("node:fs"));
        const backups = readdirSync(workDir).filter((name) => name.includes(".v1-v2-"));
        const mainFiles = backups.filter(
          (name) => !name.endsWith("-wal") && !name.endsWith("-shm"),
        );
        expect(mainFiles.length).toBe(1);
      }),
    ),
  );

  // ------------------------------------------------------------------
  // Scale: the REAL vendored Cloudflare spec (16MB, ~2,800 operations)
  // through a database that just came out of the crash-state migration.
  // Catches anything the migration leaves behind that only shows up
  // under a production-sized catalog (constraint violations, slow paths,
  // schema drift between migrated and fresh rows).
  // ------------------------------------------------------------------
  it.effect(
    "real Cloudflare spec (16MB, ~2800 ops) loads and describes on a crash-state-migrated database",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dbPath = join(workDir, "scale.db");
          yield* Effect.promise(() => seedV1Final(dbPath, { wipeJournal: true }));

          const stack = yield* Effect.promise(() => bootRealStack(dbPath));
          expect(stack.migration.migrated).toBe(true);

          const { readFileSync } = yield* Effect.promise(() => import("node:fs"));
          const { resolve: resolvePath } = yield* Effect.promise(() => import("node:path"));
          const cloudflareSpec = readFileSync(
            resolvePath(
              import.meta.dirname,
              "../../../../packages/plugins/openapi/fixtures/cloudflare.json",
            ),
            "utf-8",
          );

          const added = yield* stack.executor.openapi.addSpec({
            spec: { kind: "blob", value: cloudflareSpec },
            slug: "cloudflare_api",
            authenticationTemplate: [
              {
                slug: AuthTemplateSlug.make("apiKey"),
                type: "apiKey",
                headers: {
                  authorization: ["Bearer ", { type: "variable" as const, name: "token" }],
                },
              },
            ],
          });
          expect(added.toolCount).toBeGreaterThan(1000);

          yield* stack.executor.connections.create({
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make("cloudflare_api"),
            template: AuthTemplateSlug.make("apiKey"),
            value: "cf-test-token",
          });

          // The full production-sized catalog persisted through the
          // migrated database; schema previews resolve (payload-first, no
          // transport envelope).
          const tools = yield* stack.executor.tools.list({ includeAnnotations: false });
          const cfTools = tools.filter((tool) => String(tool.integration) === "cloudflare_api");
          expect(cfTools.length).toBeGreaterThan(1000);

          // tools.list is a light projection (no schema columns); resolve a
          // few schemas through tools.schema and assert the output preview
          // is payload-first (no transport-envelope headers map).
          const sampled = cfTools.slice(0, 25);
          const schemas = yield* Effect.all(
            sampled.map((tool) => stack.executor.tools.schema(tool.address)),
          );
          const withOutput = schemas.find((schema) => schema?.outputTypeScript !== undefined);
          expect(withOutput).toBeDefined();
          expect(withOutput?.outputTypeScript).not.toContain("headers: { [k: string]: string; }");

          yield* Effect.promise(() => stack.dispose());

          // Reboot under the full catalog: gate + ledger stay no-ops.
          const reboot = yield* Effect.promise(() => bootRealStack(dbPath));
          expect(reboot.migration.migrated).toBe(false);
          const tools2 = yield* reboot.executor.tools.list({ includeAnnotations: false });
          expect(
            tools2.filter((tool) => String(tool.integration) === "cloudflare_api").length,
          ).toBe(cfTools.length);
          yield* Effect.promise(() => reboot.dispose());
        }),
      ),
    { timeout: 120_000 },
  );
});
