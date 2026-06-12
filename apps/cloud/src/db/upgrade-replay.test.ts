// Upgrade replay: a realistic database created at the v2 BASELINE schema is
// carried through every later migration in the drizzle chain — the test prod
// never gets to run twice. Fresh-database tests only ever see the end state;
// this seeds data shaped the way the OLD code wrote it (envelope-era tool
// schemas, pre-origin oauth clients) at migration 0000, then applies the rest
// of the chain and asserts the data the migrations promise to transform was
// transformed — and everything else survived byte-for-byte.
//
// The chain is staged through drizzle's own migrator (journal + hashes), so
// this also pins that the checked-in migration set REPLAYS: a typo'd or
// hand-edited old migration that no longer applies cleanly fails here first.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "@effect/vitest";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Schema } from "effect";

const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

// The journal is staged byte-faithfully: entries keep every field the
// migrator reads (`when` becomes the history row's created_at), so the
// decode keeps the raw objects and only types what this test touches.
interface Journal {
  readonly entries: ReadonlyArray<{ readonly tag: string } & Record<string, unknown>>;
}

const journal = decodeJson(
  readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
) as Journal & Record<string, unknown>;

/** A migrations folder containing only the first `count` chain entries —
 *  what the schema looked like when the "old" database was created. */
const stageChainPrefix = (count: number): string => {
  const staged = mkdtempSync(join(tmpdir(), "cloud-migrations-prefix-"));
  mkdirSync(join(staged, "meta"));
  const entries = journal.entries.slice(0, count);
  writeFileSync(
    join(staged, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  for (const entry of entries) {
    const file = `${entry.tag}.sql`;
    writeFileSync(join(staged, file), readFileSync(join(MIGRATIONS_FOLDER, file), "utf8"));
  }
  return staged;
};

// ── The realistic old-world data, written the way pre-0001 code wrote it ────

/** The retired {status, headers, data} transport envelope, exactly as the old
 *  OpenAPI tool producer persisted it (the shape 0002 promises to unwrap). */
const envelopeSchema = (data: Record<string, unknown>) =>
  JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: ["status", "headers", "data"],
    properties: {
      status: { type: "integer" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      data,
    },
  });

const PAYLOAD_SCHEMA = { type: "object", properties: { id: { type: "string" } } };

const seedBaselineWorld = async (db: PGlite) => {
  // Two real tenants — migrations must never bleed rows across orgs.
  await db.exec(`
    INSERT INTO accounts (id) VALUES ('user_alpha'), ('user_beta');
    INSERT INTO organizations (id, name) VALUES
      ('org_acme', 'Acme'), ('org_globex', 'Globex');
    INSERT INTO memberships (account_id, organization_id) VALUES
      ('user_alpha', 'org_acme'), ('user_beta', 'org_acme'), ('user_beta', 'org_globex');

    INSERT INTO integration (slug, plugin_id, description, config, created_at, updated_at, row_id, tenant) VALUES
      ('github', 'openapi', 'GitHub API', '{"specHash":"abc123","baseUrl":"https://api.github.com"}', now(), now(), 'row_int_1', 'org_acme'),
      ('linear', 'mcp', 'Linear MCP', '{"transport":"remote","url":"https://mcp.linear.app"}', now(), now(), 'row_int_2', 'org_globex');

    INSERT INTO connection (integration, name, template, provider, item_ids, created_at, updated_at, row_id, tenant, owner, subject) VALUES
      ('github', 'shared', 'apiKey', 'vault', '{"token":"item_1"}', now(), now(), 'row_conn_1', 'org_acme', 'org', '-'),
      ('github', 'personal', 'apiKey', 'vault', '{"token":"item_2"}', now(), now(), 'row_conn_2', 'org_acme', 'user', 'user_beta');

    -- Pre-0001 oauth clients: the origin columns do not exist yet.
    INSERT INTO oauth_client (slug, authorization_url, token_url, "grant", client_id, created_at, row_id, tenant, owner, subject) VALUES
      ('github-app', 'https://github.com/login/oauth/authorize', 'https://github.com/login/oauth/access_token', 'authorization_code', 'client_abc', now(), 'row_oc_1', 'org_acme', 'org', '-');

    INSERT INTO tool_policy (id, pattern, action, position, created_at, updated_at, row_id, tenant, owner, subject) VALUES
      ('pol_1', 'tools.github.*', 'allow', '1', now(), now(), 'row_pol_1', 'org_acme', 'org', '-');

    INSERT INTO blob (namespace, key, value, row_id, id) VALUES
      ('o:org_acme/openapi', 'spec/abc123', '{"openapi":"3.0.3"}', 'row_blob_1', '["o:org_acme/openapi","spec/abc123"]');
  `);

  // Tool rows covering every shape 0002 must (and must NOT) touch.
  const tool = (
    rowId: string,
    tenant: string,
    pluginId: string,
    name: string,
    outputSchema: string | null,
  ) =>
    db.query(
      `INSERT INTO tool (integration, connection, plugin_id, name, description, output_schema, created_at, updated_at, row_id, tenant, owner, subject)
       VALUES ('github', 'shared', $1, $2, 'd', $3, now(), now(), $4, $5, 'org', '-')`,
      [pluginId, name, outputSchema, rowId, tenant],
    );
  // The envelope around a real payload schema → must unwrap to the payload.
  await tool("row_tool_env", "org_acme", "openapi", "getRepo", envelopeSchema(PAYLOAD_SCHEMA));
  // The envelope around `"data": {}` (operation declared no response schema)
  // → the new producer persists NULL for those.
  await tool("row_tool_empty", "org_acme", "openapi", "deleteRepo", envelopeSchema({}));
  // Already payload-shaped (pre-envelope era) → must NOT be touched.
  await tool("row_tool_plain", "org_acme", "openapi", "listRepos", JSON.stringify(PAYLOAD_SCHEMA));
  // No output schema at all → stays NULL.
  await tool("row_tool_null", "org_acme", "openapi", "ping", null);
  // Envelope SHAPE but a different plugin → 0002 filters on openapi; untouched.
  await tool("row_tool_mcp", "org_globex", "mcp", "createIssue", envelopeSchema(PAYLOAD_SCHEMA));
};

describe("cloud drizzle chain · upgrade replay over a realistic baseline database", () => {
  test("a database born at 0000 carries its data through every later migration", async () => {
    const db = await PGlite.create();
    const handle = drizzle(db);

    // 1. The old world: schema as the baseline release created it…
    await migrate(handle, { migrationsFolder: stageChainPrefix(1) });
    // …including what the baseline did NOT have yet.
    const preColumns = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'oauth_client'",
    );
    expect(
      preColumns.rows.map((row) => row.column_name),
      "the baseline schema predates the oauth_client origin columns",
    ).not.toContain("origin_kind");

    // 2. …populated with data shaped the way the old code wrote it.
    await seedBaselineWorld(db);

    // 3. The upgrade: every later migration applies over the live data.
    await migrate(handle, { migrationsFolder: MIGRATIONS_FOLDER });

    // 0001: the origin columns exist; pre-existing apps read as null —
    // the service layer's documented "treat as manual" contract.
    const client = await db.query<{ origin_kind: string | null; client_id: string }>(
      "SELECT origin_kind, client_id FROM oauth_client WHERE row_id = 'row_oc_1'",
    );
    expect(client.rows[0], "the pre-0001 oauth client survives with a null origin").toEqual({
      origin_kind: null,
      client_id: "client_abc",
    });

    // 0002: exactly the envelope rows transformed, everything else untouched.
    const schemas = new Map(
      (
        await db.query<{ row_id: string; output_schema: unknown }>(
          "SELECT row_id, output_schema FROM tool",
        )
      ).rows.map((row) => [row.row_id, row.output_schema]),
    );
    expect(schemas.get("row_tool_env"), "the envelope unwraps to its payload schema").toEqual(
      PAYLOAD_SCHEMA,
    );
    expect(schemas.get("row_tool_empty"), "an empty-data envelope becomes no schema").toBeNull();
    expect(schemas.get("row_tool_plain"), "a payload-shaped row is left alone").toEqual(
      PAYLOAD_SCHEMA,
    );
    expect(schemas.get("row_tool_null"), "a schema-less tool stays schema-less").toBeNull();
    expect(
      schemas.get("row_tool_mcp"),
      "another plugin's envelope-shaped schema is NOT openapi's to rewrite",
    ).toEqual(decodeJson(envelopeSchema(PAYLOAD_SCHEMA)));

    // The boring rows — the bulk of a real database — survive unchanged.
    const counts = async (table: string) =>
      Number(
        (await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n ?? -1,
      );
    expect(await counts("accounts"), "accounts intact").toBe(2);
    expect(await counts("memberships"), "memberships intact").toBe(3);
    expect(await counts("integration"), "integrations intact").toBe(2);
    expect(await counts("connection"), "connections intact").toBe(2);
    expect(await counts("blob"), "blobs intact").toBe(1);
    const connection = await db.query<{ item_ids: unknown; tenant: string }>(
      "SELECT item_ids, tenant FROM connection WHERE row_id = 'row_conn_2'",
    );
    expect(connection.rows[0], "a personal connection's credential map is untouched").toEqual({
      item_ids: { token: "item_2" },
      tenant: "org_acme",
    });

    // 4. Replaying the chain again is a no-op — the upgrade is idempotent.
    await migrate(handle, { migrationsFolder: MIGRATIONS_FOLDER });
    expect(await counts("tool"), "a second migrate run changes nothing").toBe(5);

    await db.close();
  });

  test("every chain prefix replays cleanly (no migration depends on being edited)", async () => {
    // A hand-edited historical migration usually still passes the full-chain
    // test (the edit was made to match the present) but breaks REPLAY from
    // an intermediate prefix. Walk every prefix → full upgrade.
    for (let prefix = 1; prefix < journal.entries.length; prefix++) {
      const db = await PGlite.create();
      const handle = drizzle(db);
      await migrate(handle, { migrationsFolder: stageChainPrefix(prefix) });
      await migrate(handle, { migrationsFolder: MIGRATIONS_FOLDER });
      const tables = await db.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      expect(
        tables.rows.map((row) => row.table_name),
        `prefix ${prefix} upgrades to a schema containing the executor tables`,
      ).toEqual(expect.arrayContaining(["integration", "connection", "tool", "oauth_client"]));
      await db.close();
    }
  });
});
