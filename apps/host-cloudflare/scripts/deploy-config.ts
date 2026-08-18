// The deploy-time Wrangler config for this installation.
//
// `wrangler.jsonc` is the shared template: the bindings, migrations, and
// routing every Executor deployment needs, tracked in git and updated by every
// new release. A handful of values in it belong to ONE installation, not to the
// repo — the D1 database id created in your account, the org name your console
// shows. Writing those into the tracked file (as `deploy.sh` used to) leaves the
// working tree permanently dirty, so every upgrade pull lands on a modified
// config and the operator has to hand-merge deployment state against release
// changes.
//
// So the two are kept apart:
//
//   wrangler.jsonc         tracked template   — upstream owns it, never written
//   wrangler.local.jsonc   this installation  — gitignored, only your deltas
//   wrangler.deploy.json   generated merge    — gitignored, what wrangler reads
//
// Every wrangler command that deploys or serves this app passes
// `--config wrangler.deploy.json` (see package.json + deploy.sh), so upgrading
// is `git pull` + redeploy with no config to reconcile.
//
//   bun scripts/deploy-config.ts              # write the merged config
//   bun scripts/deploy-config.ts --set-d1 ID  # record a provisioned D1 id
//
// The overlay is a partial config in the same shape as the template:
//
//   {
//     "d1_databases": [{ "binding": "DB", "database_id": "<your id>" }],
//     "vars": { "SELF_HOSTED_ORG_NAME": "Acme" }
//   }

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";

const APP_DIR = resolve(import.meta.dirname, "..");
const TEMPLATE_PATH = resolve(APP_DIR, "wrangler.jsonc");
const OVERLAY_PATH = resolve(APP_DIR, "wrangler.local.jsonc");
const GENERATED_PATH = resolve(APP_DIR, "wrangler.deploy.json");

type JsonRecord = Record<string, unknown>;

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const readConfig = (path: string): JsonRecord => {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(readFileSync(path, "utf8"), errors, {
    allowTrailingComma: true,
  }) as unknown;
  if (errors.length > 0) fail(`${path} is not valid JSONC (offset ${errors[0]?.offset})`);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`${path} must contain a JSON object`);
  }
  return parsed as JsonRecord;
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A binding entry's identity: `binding` for resource bindings (D1, R2, KV),
 *  `name` for Durable Object bindings. Entries without one are positional. */
const identity = (entry: unknown): string | null => {
  if (!isRecord(entry)) return null;
  const key = entry.binding ?? entry.name;
  return typeof key === "string" ? key : null;
};

/**
 * Merge an overlay array over a base array by binding identity: an overlay
 * entry patches the base entry it names (so an overlay can supply just a
 * `database_id`) and any unmatched entry is appended. Arrays of non-bindings
 * (`compatibility_flags`, `migrations`, `run_worker_first`) are release-owned
 * lists, so an overlay entry replaces the base wholesale rather than
 * accumulating stale values across upgrades.
 */
const mergeArray = (base: readonly unknown[], overlay: readonly unknown[]): unknown[] => {
  if (!overlay.every((entry) => identity(entry) !== null)) return [...overlay];
  const merged = base.map((entry) => {
    const match = overlay.find((candidate) => identity(candidate) === identity(entry));
    return match && isRecord(entry) && isRecord(match) ? mergeRecords(entry, match) : entry;
  });
  const added = overlay.filter(
    (entry) => !base.some((candidate) => identity(candidate) === identity(entry)),
  );
  return [...merged, ...added];
};

const mergeRecords = (base: JsonRecord, overlay: JsonRecord): JsonRecord => {
  const merged: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = merged[key];
    if (isRecord(current) && isRecord(value)) {
      merged[key] = mergeRecords(current, value);
    } else if (Array.isArray(current) && Array.isArray(value)) {
      merged[key] = mergeArray(current, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
};

const readOverlay = (): JsonRecord => (existsSync(OVERLAY_PATH) ? readConfig(OVERLAY_PATH) : {});

const NEW_OVERLAY_HEADER = `// This installation's Wrangler deltas — gitignored, merged over the tracked
// wrangler.jsonc template into wrangler.deploy.json at deploy time (see
// scripts/deploy-config.ts). Hand-edit it freely: only the keys set here
// override the template, and comments survive \`deploy:setup\` re-runs.
`;

/**
 * Record a provisioned D1 database id in the overlay. `deploy.sh` calls this
 * after creating or finding the database, so the tracked template keeps
 * whatever id it shipped with. The write is a surgical JSONC edit rather than a
 * reserialize — an operator's comments and formatting in a file they maintain
 * survive every re-run.
 */
const setD1DatabaseId = (databaseId: string): void => {
  const template = readConfig(TEMPLATE_PATH);
  const templateDatabases = Array.isArray(template.d1_databases) ? template.d1_databases : [];
  const binding = identity(templateDatabases[0]) ?? "DB";
  if (!existsSync(OVERLAY_PATH)) {
    const seed = { d1_databases: [{ binding, database_id: databaseId }] };
    writeFileSync(OVERLAY_PATH, `${NEW_OVERLAY_HEADER}${JSON.stringify(seed, null, 2)}\n`);
    return;
  }
  const text = readFileSync(OVERLAY_PATH, "utf8");
  const databases = readOverlay().d1_databases;
  const entries = Array.isArray(databases) ? databases : [];
  const index = entries.findIndex((entry) => identity(entry) === binding);
  const options = { formattingOptions: { tabSize: 2, insertSpaces: true } };
  const edits =
    index === -1
      ? modify(
          text,
          ["d1_databases", entries.length],
          { binding, database_id: databaseId },
          options,
        )
      : modify(text, ["d1_databases", index, "database_id"], databaseId, options);
  writeFileSync(OVERLAY_PATH, applyEdits(text, edits));
};

const writeGeneratedConfig = (): string => {
  const merged = mergeRecords(readConfig(TEMPLATE_PATH), readOverlay());
  // A generated file: JSON, no comments, never hand-edited. Wrangler resolves
  // `main` and `assets.directory` relative to the config file, so this must
  // stay beside the template it was derived from.
  writeFileSync(GENERATED_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  return GENERATED_PATH;
};

const args = process.argv.slice(2);
const setD1Index = args.indexOf("--set-d1");
if (setD1Index !== -1) {
  const databaseId = args[setD1Index + 1];
  if (!databaseId) fail("--set-d1 needs a database id");
  setD1DatabaseId(databaseId);
}
process.stdout.write(`${writeGeneratedConfig()}\n`);
