import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { Schema } from "effect";

import { type VmRunMetadata, vmRunScopeSlug } from "./run-scope";

const MANAGED_BY = "executor-e2e-tart-v1";
const LEDGER_FILE = /^[a-f0-9]{64}\.json$/;

export const TartOwnership = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  managedBy: Schema.Literal(MANAGED_BY),
  repository: Schema.String,
  runId: Schema.String,
  runAttempt: Schema.String,
  runScope: Schema.String,
  os: Schema.Literals(["linux", "macos"]),
  vmName: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
});

export type TartOwnership = typeof TartOwnership.Type;

export interface TartOwnershipLedger {
  readonly path: string;
  readonly record: TartOwnership;
}

type Environment = Readonly<Record<string, string | undefined>>;

const nonempty = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const tartOwnershipRoot = (environment: Environment = process.env) =>
  resolve(nonempty(environment.E2E_TART_STATE_ROOT) ?? join(homedir(), ".executor-e2e", "tart"));

const ledgerFilename = (vmName: string) =>
  `${createHash("sha256").update(vmName).digest("hex")}.json`;

export const tartOwnershipPath = (root: string, vmName: string) =>
  join(resolve(root), ledgerFilename(vmName));

const assertValidOwnership = (record: TartOwnership, path?: string) => {
  const required = [record.repository, record.runId, record.runAttempt, record.runScope];
  if (required.some((value) => value.trim().length === 0)) {
    throw new Error(`tart ownership contains an empty identity field: ${record.vmName}`);
  }
  const createdAt = Date.parse(record.createdAt);
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt > expiresAt) {
    throw new Error(`tart ownership has an invalid lifetime: ${record.vmName}`);
  }
  const expectedPrefix = `executor-e2e-${vmRunScopeSlug(record.runScope)}-${record.os}-`;
  if (!record.vmName.startsWith(expectedPrefix)) {
    throw new Error(`tart ownership has an invalid VM name: ${record.vmName}`);
  }
  if (path && basename(path) !== ledgerFilename(record.vmName)) {
    throw new Error(`tart ownership filename does not match VM name: ${basename(path)}`);
  }
};

export const createTartOwnership = (
  metadata: VmRunMetadata,
  os: "linux" | "macos",
  vmName: string,
): TartOwnership => ({
  schemaVersion: 1,
  managedBy: MANAGED_BY,
  repository: metadata.repository,
  runId: metadata.runId,
  runAttempt: metadata.runAttempt,
  runScope: metadata.scope,
  os,
  vmName,
  createdAt: metadata.createdAt,
  expiresAt: metadata.expiresAt,
});

export const writeTartOwnership = (
  record: TartOwnership,
  environment: Environment = process.env,
) => {
  assertValidOwnership(record);
  const root = tartOwnershipRoot(environment);
  mkdirSync(root, { mode: 0o700, recursive: true });
  const path = tartOwnershipPath(root, record.vmName);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  return { path, record } satisfies TartOwnershipLedger;
};

const decodeOwnership = Schema.decodeUnknownSync(Schema.fromJsonString(TartOwnership));

export const readTartOwnership = (environment: Environment = process.env) => {
  const root = tartOwnershipRoot(environment);
  if (!existsSync(root)) return [];
  const ledgers: TartOwnershipLedger[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile() || !LEDGER_FILE.test(entry.name)) {
      throw new Error(`unsafe tart ownership entry: ${entry.name}`);
    }
    const path = join(root, entry.name);
    const record = decodeOwnership(readFileSync(path, "utf8"));
    assertValidOwnership(record, path);
    ledgers.push({ path, record });
  }
  return ledgers;
};

export const removeTartOwnership = (ledger: TartOwnershipLedger) => {
  const expectedPath = tartOwnershipPath(dirname(ledger.path), ledger.record.vmName);
  if (ledger.path !== expectedPath) {
    throw new Error(`refusing to remove mismatched tart ownership path: ${ledger.path}`);
  }
  rmSync(ledger.path, { force: true });
};

export const requireTartCleanupOwner = (environment: Environment = process.env) => {
  const scope = nonempty(environment.E2E_VM_RUN_SCOPE);
  const repository = nonempty(environment.GITHUB_REPOSITORY);
  const runId = nonempty(environment.GITHUB_RUN_ID);
  const runAttempt = nonempty(environment.GITHUB_RUN_ATTEMPT);
  if (!scope || !repository || !runId || !runAttempt) {
    throw new Error(
      "Tart cleanup requires E2E_VM_RUN_SCOPE, GITHUB_REPOSITORY, GITHUB_RUN_ID, and GITHUB_RUN_ATTEMPT",
    );
  }
  return { repository, runAttempt, runId, scope };
};

export const selectCurrentTartOwnership = (
  ledgers: readonly TartOwnershipLedger[],
  owner: ReturnType<typeof requireTartCleanupOwner>,
) =>
  ledgers.filter(
    ({ record }) =>
      record.repository === owner.repository &&
      record.runId === owner.runId &&
      record.runAttempt === owner.runAttempt &&
      record.runScope === owner.scope,
  );

export const selectExpiredTartOwnership = (
  ledgers: readonly TartOwnershipLedger[],
  owner: ReturnType<typeof requireTartCleanupOwner>,
  minimumAgeHours: number,
  now = Date.now(),
) => {
  if (!Number.isFinite(minimumAgeHours) || minimumAgeHours <= 0) {
    throw new Error("minimumAgeHours must be greater than zero");
  }
  const minimumAgeMs = minimumAgeHours * 60 * 60 * 1_000;
  return ledgers.filter(({ record }) => {
    if (record.repository !== owner.repository) return false;
    assertValidOwnership(record);
    if (record.runId === owner.runId && record.runAttempt === owner.runAttempt) return false;
    const createdAt = Date.parse(record.createdAt);
    const expiresAt = Date.parse(record.expiresAt);
    if (createdAt > now) throw new Error(`tart ownership is dated in the future: ${record.vmName}`);
    return expiresAt <= now && now - createdAt >= minimumAgeMs;
  });
};
