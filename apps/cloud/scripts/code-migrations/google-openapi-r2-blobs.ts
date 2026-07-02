/* oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: migration copies remote R2 objects through wrangler */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import type { CodeMigration, CodeMigrationContext } from "./runner";

export interface R2ObjectStore {
  readonly exists: (key: string) => boolean;
  readonly get: (key: string, file: string) => void;
  readonly put: (key: string, file: string) => void;
}

export interface GoogleOpenApiR2BlobMigrationOptions {
  readonly bucket: string;
  readonly limit?: number;
  readonly store?: R2ObjectStore;
}

interface GoogleDiscoveryRow {
  readonly tenant: string;
  readonly slug: string;
  readonly plugin_id: string;
  readonly spec_hash: string;
}

const sha256Buffer = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");
const sha256Text = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const makeWranglerR2ObjectStore = (bucket: string): R2ObjectStore => {
  const objectPath = (key: string): string => `${bucket}/${key}`;
  const args = (command: "get" | "put", key: string, file: string): readonly string[] =>
    command === "get"
      ? ["r2", "object", "get", objectPath(key), "--file", file, "--remote"]
      : ["r2", "object", "put", objectPath(key), "--file", file, "--remote", "--force"];

  return {
    exists: (key) => {
      const file = join(tmpdir(), `executor-r2-exists-${sha256Text(key)}`);
      const result = spawnSync("wrangler", args("get", key, file), {
        stdio: ["ignore", "ignore", "ignore"],
      });
      return result.status === 0;
    },
    get: (key, file) => {
      execFileSync("wrangler", args("get", key, file), {
        stdio: ["ignore", "ignore", "inherit"],
      });
    },
    put: (key, file) => {
      execFileSync("wrangler", args("put", key, file), {
        stdio: ["ignore", "ignore", "inherit"],
      });
    },
  };
};

const blobKey = (tenant: string, pluginId: "openapi" | "google", specHash: string): string =>
  `o:${tenant}/${pluginId}/spec/${specHash}`;

const readRows = (context: CodeMigrationContext): Promise<readonly GoogleDiscoveryRow[]> =>
  context.sql.unsafe<GoogleDiscoveryRow[]>(`
    SELECT
      tenant,
      slug,
      plugin_id,
      config::jsonb ->> 'specHash' AS spec_hash
    FROM integration
    WHERE plugin_id IN ('openapi', 'google')
      AND config IS NOT NULL
      AND jsonb_typeof(config::jsonb -> 'googleDiscoveryUrls') = 'array'
      AND coalesce(config::jsonb ->> 'specHash', '') <> ''
    ORDER BY tenant, slug
  `);

export const googleOpenApiR2BlobMigration = ({
  bucket,
  limit,
  store = makeWranglerR2ObjectStore(bucket),
}: GoogleOpenApiR2BlobMigrationOptions): CodeMigration => ({
  name: "2026-06-20-google-openapi-r2-blobs",
  run: async (context) => {
    const rows = await readRows(context);
    const work = rows.slice(0, Number.isFinite(limit) ? limit : rows.length);
    if (work.length < rows.length) {
      context.log(`[code-migrate] --limit: checking first ${work.length} of ${rows.length}`);
    }

    let sourcesPresent = 0;
    let targetsPresent = 0;
    let copied = 0;
    const missingSources: string[] = [];
    const conflictingTargets: string[] = [];
    const tempDir = mkdtempSync(join(tmpdir(), "google-openapi-blobs-"));

    try {
      for (const [index, row] of work.entries()) {
        const sourceKey = blobKey(row.tenant, "openapi", row.spec_hash);
        const targetKey = blobKey(row.tenant, "google", row.spec_hash);

        if (context.dryRun) {
          if (store.exists(sourceKey)) sourcesPresent += 1;
          else missingSources.push(`${row.tenant}/${row.slug}`);
          if (store.exists(targetKey)) targetsPresent += 1;
          continue;
        }

        const sourceFile = join(tempDir, `source-${index}`);
        const targetFile = join(tempDir, `target-${index}`);
        const verifyFile = join(tempDir, `verify-${index}`);

        try {
          store.get(sourceKey, sourceFile);
        } catch {
          missingSources.push(`${row.tenant}/${row.slug}`);
          continue;
        }

        const sourceHash = sha256Buffer(readFileSync(sourceFile));
        if (store.exists(targetKey)) {
          store.get(targetKey, targetFile);
          const targetHash = sha256Buffer(readFileSync(targetFile));
          if (targetHash === sourceHash) {
            targetsPresent += 1;
            continue;
          }
          conflictingTargets.push(`${row.tenant}/${row.slug}`);
          continue;
        }

        store.put(targetKey, sourceFile);
        store.get(targetKey, verifyFile);
        const verifyHash = sha256Buffer(readFileSync(verifyFile));
        if (verifyHash !== sourceHash) {
          throw new Error(`R2 round-trip mismatch for ${targetKey}`);
        }
        copied += 1;
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    if (missingSources.length > 0) {
      throw new Error(
        `${missingSources.length} source object(s) missing: ${missingSources.join(", ")}`,
      );
    }
    if (conflictingTargets.length > 0) {
      throw new Error(
        `${conflictingTargets.length} conflicting target object(s): ${conflictingTargets.join(", ")}`,
      );
    }

    if (context.dryRun) {
      return {
        summary:
          `${rows.length} Google Discovery integration row(s), ` +
          `${sourcesPresent}/${work.length} source R2 object(s) present, ` +
          `${targetsPresent}/${work.length} target R2 object(s) already present, ` +
          `would copy ${Math.max(sourcesPresent - targetsPresent, 0)} object(s)`,
      };
    }

    return {
      summary:
        `${rows.length} Google Discovery integration row(s), ` +
        `copied ${copied} R2 object(s), ` +
        `${targetsPresent} target object(s) already present`,
    };
  },
});
