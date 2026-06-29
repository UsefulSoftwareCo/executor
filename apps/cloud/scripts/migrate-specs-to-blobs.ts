/* oxlint-disable executor/no-try-catch-or-throw, executor/no-json-parse, executor/no-error-constructor -- boundary: out-of-band migration script over a raw postgres connection + wrangler subprocess */
// ---------------------------------------------------------------------------
// One-off data migration: move inline spec text out of `integration.config`
// into the blob store the deployed worker reads.
//
//   openapi: config.spec             -> blob spec/<sha256>,          config.specHash
//   graphql: config.introspectionJson -> blob introspection/<sha256>, config.introspectionHash
//
// Blob object names follow the runtime seam exactly
// (`pluginBlobStore` + `makeR2BlobStore`): `o:<tenant>/<plugin>/<key>`.
//
// The blob TARGET must match what the worker is deployed with:
//   --target r2 --bucket executor-cloud-blobs   # wrangler-authed R2 writes
//   --target db                                  # the Postgres `blob` table
// Run AFTER the worker that reads `specHash` is deployable, BEFORE relying
// on it for latency (legacy inline rows keep working either way).
//
//   bun run db:migrate-specs:prod -- --target r2 --bucket executor-cloud-blobs
//   bun run db:migrate-specs:dev -- --target db
//
// Rows are processed ONE AT A TIME (the inline specs total ~500 MB in prod;
// never load them all). Idempotent: pointer-shaped rows plan zero work, blob
// writes are content-addressed, and a re-run resumes where it left off.
// Pass --dry-run to print the plan without writing, --limit N for a canary.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";
import { Option } from "effect";
import { decodeOpenApiIntegrationConfig } from "@executor-js/plugin-openapi";
import { decodeGraphqlIntegrationConfigOption } from "@executor-js/plugin-graphql";

// --- per-plugin shape: which inline field moves, to which blob key prefix ---

interface SpecField {
  readonly inlineField: string;
  readonly hashField: string;
  readonly blobKeyPrefix: string;
  readonly decodes: (config: unknown) => boolean;
}

const SPEC_FIELDS: Record<string, SpecField> = {
  openapi: {
    inlineField: "spec",
    hashField: "specHash",
    blobKeyPrefix: "spec",
    decodes: (config) => decodeOpenApiIntegrationConfig(config) !== null,
  },
  graphql: {
    inlineField: "introspectionJson",
    hashField: "introspectionHash",
    blobKeyPrefix: "introspection",
    decodes: (config) => Option.isSome(decodeGraphqlIntegrationConfigOption(config)),
  },
};

// --- args ---

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const dryRun = process.argv.includes("--dry-run");
const target = argValue("--target") ?? "r2";
const bucket = argValue("--bucket");
const limit = Number(argValue("--limit") ?? Infinity);

if (target !== "r2" && target !== "db") {
  console.error(`--target must be "r2" or "db", got "${target}"`);
  process.exit(1);
}
if (target === "r2" && !bucket && !dryRun) {
  console.error("--target r2 requires --bucket <name> (e.g. executor-cloud-blobs)");
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

// Direct (non-Hyperdrive) connection — PlanetScale requires TLS.
const sql = postgres(connectionString, { max: 1, prepare: false, ssl: "require" });

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// Runtime object naming, byte-for-byte: `pluginBlobStore` namespaces by
// `o:<tenant>/<pluginId>` and `makeR2BlobStore` joins `namespace/key`; the
// FumaDB store keys rows by `JSON.stringify([namespace, key])`.
const blobNamespace = (tenant: string, pluginId: string) => `o:${tenant}/${pluginId}`;
const fumaBlobId = (namespace: string, key: string) => JSON.stringify([namespace, key]);

// --- blob writers (verify-on-write: a pointer must never replace a spec the
// --- store can't serve back) ---

const tempDir = mkdtempSync(join(tmpdir(), "spec-blobs-"));

const putBlobR2 = (objectName: string, value: string): void => {
  const file = join(tempDir, "blob-upload");
  writeFileSync(file, value, "utf8");
  execFileSync(
    "wrangler",
    ["r2", "object", "put", `${bucket}/${objectName}`, "--file", file, "--remote"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const verifyFile = join(tempDir, "blob-verify");
  execFileSync(
    "wrangler",
    ["r2", "object", "get", `${bucket}/${objectName}`, "--file", verifyFile, "--remote"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const roundTripped = readFileSync(verifyFile, "utf8");
  if (sha256Hex(roundTripped) !== sha256Hex(value)) {
    throw new Error(`R2 round-trip mismatch for ${objectName}`);
  }
};

const putBlobDb = async (namespace: string, key: string, value: string): Promise<void> => {
  const id = fumaBlobId(namespace, key);
  await sql`
    INSERT INTO blob (namespace, key, value, id)
    VALUES (${namespace}, ${key}, ${value}, ${id})
    ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value
  `;
};

// --- main ---

try {
  // Plan pass: metadata only — never load every config at once.
  const candidates = await sql<
    { row_id: string; tenant: string; slug: string; plugin_id: string; config_bytes: number }[]
  >`
    SELECT row_id, tenant, slug, plugin_id, length(config::text) AS config_bytes
    FROM integration
    WHERE (plugin_id = 'openapi' AND config::jsonb ? 'spec')
       OR (plugin_id = 'graphql' AND config::jsonb ? 'introspectionJson')
    ORDER BY row_id
  `;

  const totalBytes = candidates.reduce((sum, row) => sum + Number(row.config_bytes), 0);
  console.log(
    `${candidates.length} row(s) carry inline spec text (${(totalBytes / 1024 / 1024).toFixed(1)} MB total config)`,
  );

  const work = candidates.slice(0, Number.isFinite(limit) ? limit : candidates.length);
  if (work.length < candidates.length) console.log(`--limit: processing first ${work.length}`);

  if (dryRun) {
    for (const row of work) {
      console.log(
        `  would move ${row.plugin_id} ${row.tenant}/${row.slug} (${(Number(row.config_bytes) / 1024).toFixed(0)} kB) -> blob`,
      );
    }
    process.exit(0);
  }

  let moved = 0;
  const writtenObjects = new Set<string>();

  for (const candidate of work) {
    const field = SPEC_FIELDS[candidate.plugin_id];
    if (!field) continue;

    // Fetch this one row's config — one multi-MB value in memory at a time.
    const [row] = await sql<{ config: unknown }[]>`
      SELECT config FROM integration WHERE row_id = ${candidate.row_id}
    `;
    if (!row) continue;
    const config = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
    if (typeof config !== "object" || config === null) continue;

    const inline = (config as Record<string, unknown>)[field.inlineField];
    if (typeof inline !== "string") continue; // already migrated (or foreign shape)

    const hash = sha256Hex(inline);
    const namespace = blobNamespace(candidate.tenant, candidate.plugin_id);
    const blobKey = `${field.blobKeyPrefix}/${hash}`;
    const objectName = `${namespace}/${blobKey}`;

    // Audit BEFORE writing: the rewritten config must decode under the
    // deployed runtime, or this row would read as "no usable config".
    const { [field.inlineField]: _removed, ...rest } = config as Record<string, unknown>;
    const nextConfig = { ...rest, [field.hashField]: hash };
    if (!field.decodes(nextConfig)) {
      console.error(`SKIP ${candidate.tenant}/${candidate.slug}: rewrite would not decode`);
      continue;
    }

    // Content-addressed: identical specs (same tenant) write once.
    if (!writtenObjects.has(objectName)) {
      if (target === "r2") putBlobR2(objectName, inline);
      else await putBlobDb(namespace, blobKey, inline);
      writtenObjects.add(objectName);
    }

    await sql`
      UPDATE integration
      SET config = ${sql.json(nextConfig as never)}
      WHERE row_id = ${candidate.row_id}
    `;

    moved += 1;
    console.log(
      `moved ${candidate.plugin_id} ${candidate.tenant}/${candidate.slug} -> ${field.blobKeyPrefix}/${hash.slice(0, 12)}… (${moved}/${work.length})`,
    );
  }

  console.log(`done: ${moved} row(s) rewritten, ${writtenObjects.size} blob object(s) written`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
  await sql.end();
}
