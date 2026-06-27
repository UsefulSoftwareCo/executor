import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

const positiveIntegerFromEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const LOCK_TIMEOUT_MS = positiveIntegerFromEnv("E2E_ARTIFACT_LOCK_TIMEOUT_MS", 10_000);
const STALE_LOCK_MS = positiveIntegerFromEnv("E2E_ARTIFACT_LOCK_STALE_MS", 30_000);
const HEARTBEAT_INTERVAL_MS = Math.max(20, Math.min(1_000, Math.floor(STALE_LOCK_MS / 4)));
const TOMBSTONE_RETENTION_MS = Math.max(60_000, STALE_LOCK_MS, LOCK_TIMEOUT_MS * 4);
const LOCK_RETRY_MS = 10;
const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const HEARTBEAT_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const { readFileSync, utimesSync } = require("node:fs");
  const locks = new Map();
  const beat = (key, lock) => {
    try {
      if (readFileSync(lock.ownerFile, "utf8") !== lock.owner) {
        locks.delete(key);
        return;
      }
      const now = new Date();
      utimesSync(lock.heartbeatFile, now, now);
    } catch {
      locks.delete(key);
    }
  };
  parentPort.on("message", (message) => {
    if (message.type === "add") {
      locks.set(message.key, message);
      beat(message.key, message);
    } else if (message.type === "remove" && locks.get(message.key)?.owner === message.owner) {
      locks.delete(message.key);
    }
  });
  setInterval(() => {
    for (const [key, lock] of locks) beat(key, lock);
  }, workerData.intervalMs);
`;
let sharedHeartbeatWorker: Worker | undefined;

const invocation = {
  id: randomUUID(),
  startedAt: Date.now(),
  runtime: {
    name: process.versions.bun ? "bun" : "node",
    version: process.versions.bun ?? process.version,
    platform: process.platform,
    arch: process.arch,
  },
} as const;

export interface EvidenceInvocation {
  readonly id: string;
  readonly startedAt: number;
  readonly runtime: {
    readonly name: string;
    readonly version: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
}

export interface EvidenceContext {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly invocations: ReadonlyArray<EvidenceInvocation>;
}

export interface EvidenceReference {
  readonly attemptId: string;
  readonly invocationId: string;
}

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

interface LockOwner {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly pid: number;
  readonly processStartIdentity?: string;
}

const linuxProcessStartIdentity = (pid: number) => {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) return undefined;
    // After the command, index 0 is field 3 (state), so field 22
    // (process start time in clock ticks) is index 19.
    return stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/)[19];
  } catch {
    return undefined;
  }
};

const processStartIdentity = linuxProcessStartIdentity(process.pid);

const lockOwner = (token: string): LockOwner => ({
  schemaVersion: 1,
  token,
  pid: process.pid,
  ...(processStartIdentity ? { processStartIdentity } : {}),
});

const parseLockOwner = (value: string | undefined): LockOwner | undefined => {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    if (!("schemaVersion" in parsed) || parsed.schemaVersion !== 1) return undefined;
    if (!("token" in parsed) || typeof parsed.token !== "string" || parsed.token === "") {
      return undefined;
    }
    if (
      !("pid" in parsed) ||
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0
    ) {
      return undefined;
    }
    const parsedProcessStartIdentity =
      "processStartIdentity" in parsed ? parsed.processStartIdentity : undefined;
    if (
      parsedProcessStartIdentity !== undefined &&
      typeof parsedProcessStartIdentity !== "string"
    ) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      token: parsed.token,
      pid: parsed.pid,
      ...(typeof parsedProcessStartIdentity === "string"
        ? { processStartIdentity: parsedProcessStartIdentity }
        : {}),
    };
  } catch {
    return undefined;
  }
};

const lockOwnerIsAlive = (value: string | undefined): boolean => {
  const owner = parseLockOwner(value);
  if (!owner) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    // EPERM still proves that a process owns this PID. Unknown failures are
    // conservative too: timing out is safer than admitting two writers.
    if (errorCode(error) === "ESRCH") return false;
    return true;
  }
  if (!owner.processStartIdentity) return true;
  const currentIdentity = linuxProcessStartIdentity(owner.pid);
  return currentIdentity === undefined || currentIdentity === owner.processStartIdentity;
};

const pause = (): void => {
  Atomics.wait(sleeper, 0, 0, LOCK_RETRY_MS);
};

interface LockSnapshot {
  readonly owner: string | undefined;
  readonly heartbeatMtimeMs: number;
}

const lockSnapshot = (lockDir: string): LockSnapshot | undefined => {
  try {
    let owner: string | undefined;
    try {
      owner = readFileSync(join(lockDir, "owner"), "utf8");
    } catch {
      owner = undefined;
    }
    let heartbeatMtimeMs: number;
    try {
      heartbeatMtimeMs = statSync(join(lockDir, "heartbeat")).mtimeMs;
    } catch {
      heartbeatMtimeMs = statSync(lockDir).mtimeMs;
    }
    return { owner, heartbeatMtimeMs };
  } catch {
    return undefined;
  }
};

const removeLockIfOwned = (lockDir: string, owner: string): void => {
  if (lockSnapshot(lockDir)?.owner === owner) {
    rmSync(lockDir, { recursive: true, force: true });
  }
};

const heartbeatIsStale = (snapshot: LockSnapshot): boolean =>
  Date.now() - snapshot.heartbeatMtimeMs > STALE_LOCK_MS;

const lockIsReclaimable = (snapshot: LockSnapshot): boolean =>
  heartbeatIsStale(snapshot) && !lockOwnerIsAlive(snapshot.owner);

const snapshotIdentity = (snapshot: LockSnapshot): string => {
  const owner = parseLockOwner(snapshot.owner);
  return (
    owner?.token ??
    snapshot.owner ??
    `unknown-${Math.floor(snapshot.heartbeatMtimeMs)}`
  ).replace(/[^a-zA-Z0-9-]/g, "_");
};

const recoveryPrefix = (lockDir: string): string => `${basename(lockDir)}.reclaim-`;
const tombstonePrefix = (lockDir: string): string => `${basename(lockDir)}.tombstone-`;

const archiveStaleRecovery = (
  lockDir: string,
  recoveryDir: string,
  observed: LockSnapshot,
): boolean => {
  if (!lockIsReclaimable(observed)) return false;
  const current = lockSnapshot(recoveryDir);
  if (
    !current ||
    current.owner !== observed.owner ||
    current.heartbeatMtimeMs !== observed.heartbeatMtimeMs ||
    !lockIsReclaimable(current)
  ) {
    return false;
  }

  const identity = snapshotIdentity(observed);
  const tombstone = `${lockDir}.tombstone-recovery-${identity}-${randomUUID()}`;
  try {
    renameSync(recoveryDir, tombstone);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }

  const moved = lockSnapshot(tombstone);
  if (moved?.owner !== observed.owner) {
    // A replacement fence moved instead of the one we observed. Restore it
    // so its owner remains visible to every contender.
    renameSync(tombstone, recoveryDir);
    return false;
  }
  return true;
};

const recoveryInProgress = (lockDir: string): boolean => {
  let entries: string[];
  try {
    entries = readdirSync(dirname(lockDir));
  } catch {
    return false;
  }
  let active = false;
  for (const name of entries) {
    if (!name.startsWith(recoveryPrefix(lockDir))) continue;
    const recoveryDir = join(dirname(lockDir), name);
    const observed = lockSnapshot(recoveryDir);
    if (!observed || !archiveStaleRecovery(lockDir, recoveryDir, observed)) active = true;
  }
  return active;
};

const cleanupOldTombstones = (lockDir: string): void => {
  const parent = dirname(lockDir);
  try {
    for (const name of readdirSync(parent)) {
      if (!name.startsWith(tombstonePrefix(lockDir))) continue;
      const tombstone = join(parent, name);
      try {
        if (Date.now() - statSync(tombstone).mtimeMs > TOMBSTONE_RETENTION_MS) {
          rmSync(tombstone, { recursive: true, force: true });
        }
      } catch {
        // Another contender may already be cleaning this completed tombstone.
      }
    }
  } catch {
    // The parent can disappear during temporary-directory cleanup.
  }
};

/**
 * Fence stale recovery with a deterministic owner-specific directory. The
 * stale lock is moved under that fence atomically, then the fence becomes a
 * retained tombstone. New owners that race the recovery see the active fence
 * and retry before entering their critical section.
 */
const reclaimStaleLock = (lockDir: string, observed: LockSnapshot): boolean => {
  if (!lockIsReclaimable(observed)) return false;
  const identity = snapshotIdentity(observed);
  const reclaimerToken = randomUUID();
  const reclaimer = JSON.stringify(lockOwner(reclaimerToken));
  const recoveryDir = `${lockDir}.reclaim-${identity}`;
  let recoveryHeartbeat: LockHeartbeat | undefined;
  try {
    mkdirSync(recoveryDir, { mode: 0o700 });
    writeFileSync(join(recoveryDir, "owner"), reclaimer, { mode: 0o600, flag: "wx" });
    recoveryHeartbeat = startLockHeartbeat(recoveryDir, reclaimer);
  } catch (error) {
    removeLockIfOwned(recoveryDir, reclaimer);
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }

  const movedLock = join(recoveryDir, "lock");
  try {
    const current = lockSnapshot(lockDir);
    if (
      !current ||
      current.owner !== observed.owner ||
      current.heartbeatMtimeMs !== observed.heartbeatMtimeMs ||
      !lockIsReclaimable(current)
    ) {
      return false;
    }

    try {
      renameSync(lockDir, movedLock);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }

    const moved = lockSnapshot(movedLock);
    if (moved?.owner !== observed.owner) {
      // A new owner slipped between the final observation and rename. It has
      // not entered its action because this recovery fence is still visible.
      renameSync(movedLock, lockDir);
      return false;
    }

    const tombstone = `${lockDir}.tombstone-${identity}-${reclaimerToken}`;
    renameSync(recoveryDir, tombstone);
    return true;
  } finally {
    recoveryHeartbeat?.stop();
    if (existsSync(recoveryDir)) {
      let recoveryOwner: string | undefined;
      try {
        recoveryOwner = readFileSync(join(recoveryDir, "owner"), "utf8");
      } catch {
        recoveryOwner = undefined;
      }
      if (recoveryOwner === reclaimer) {
        rmSync(recoveryDir, { recursive: true, force: true });
      }
    }
  }
};

interface LockHeartbeat {
  readonly stop: () => void;
}

const heartbeatWorker = (): Worker => {
  if (sharedHeartbeatWorker) return sharedHeartbeatWorker;
  const worker = new Worker(HEARTBEAT_WORKER_SOURCE, {
    eval: true,
    workerData: { intervalMs: HEARTBEAT_INTERVAL_MS },
  });
  worker.on("error", () => {
    if (sharedHeartbeatWorker === worker) sharedHeartbeatWorker = undefined;
  });
  worker.on("exit", () => {
    if (sharedHeartbeatWorker === worker) sharedHeartbeatWorker = undefined;
  });
  worker.unref();
  sharedHeartbeatWorker = worker;
  return worker;
};

const startLockHeartbeat = (lockDir: string, owner: string): LockHeartbeat => {
  const heartbeatFile = join(lockDir, "heartbeat");
  writeFileSync(heartbeatFile, owner, { mode: 0o600 });
  const worker = heartbeatWorker();
  worker.postMessage({
    type: "add",
    key: lockDir,
    owner,
    ownerFile: join(lockDir, "owner"),
    heartbeatFile,
  });
  return {
    stop: () => worker.postMessage({ type: "remove", key: lockDir, owner }),
  };
};

/**
 * Serialize a short read-modify-write transaction across processes. Directory
 * creation is atomic on the filesystems used by the e2e hosts, including
 * Windows, unlike a probe followed by creating a normal lock file.
 */
export const withArtifactLockSync = <A>(file: string, action: () => A): A => {
  const lockDir = `${file}.lock`;
  const owner = JSON.stringify(lockOwner(randomUUID()));
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let heartbeat: LockHeartbeat | undefined;
  cleanupOldTombstones(lockDir);

  for (;;) {
    if (Date.now() >= deadline) throw new Error(`e2e evidence lock timed out: ${file}`);
    if (recoveryInProgress(lockDir)) {
      pause();
      continue;
    }
    try {
      mkdirSync(lockDir, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const observed = lockSnapshot(lockDir);
      if (observed && reclaimStaleLock(lockDir, observed)) {
        continue;
      }
      pause();
      continue;
    }

    try {
      // Exclusive creation prevents a displaced claimant from overwriting a
      // replacement owner's identity if its empty directory was reclaimed.
      writeFileSync(join(lockDir, "owner"), owner, { mode: 0o600, flag: "wx" });
      heartbeat = startLockHeartbeat(lockDir, owner);
    } catch (error) {
      removeLockIfOwned(lockDir, owner);
      if (errorCode(error) === "EEXIST" || errorCode(error) === "ENOENT") {
        pause();
        continue;
      }
      throw error;
    }

    // Recovery can move the directory between mkdir, owner creation, and
    // heartbeat startup. Enter only while the canonical path still names us.
    if (recoveryInProgress(lockDir) || lockSnapshot(lockDir)?.owner !== owner) {
      heartbeat.stop();
      heartbeat = undefined;
      removeLockIfOwned(lockDir, owner);
      pause();
      continue;
    }
    break;
  }

  try {
    return action();
  } finally {
    heartbeat?.stop();
    // A stale-lock recovery could have replaced us. Never remove a lock now
    // owned by another writer.
    removeLockIfOwned(lockDir, owner);
  }
};

/** Write a complete file then atomically publish it with a same-dir rename. */
export const writeTextAtomicSync = (file: string, contents: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: number | undefined;
  try {
    handle = openSync(temporary, "wx", 0o600);
    writeFileSync(handle, contents, "utf8");
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, file);
  } finally {
    if (handle !== undefined) closeSync(handle);
    rmSync(temporary, { force: true });
  }
};

export const writeJsonAtomicSync = (file: string, value: unknown): void =>
  writeTextAtomicSync(file, JSON.stringify(value, null, 1));

const isEvidenceInvocation = (value: unknown): value is EvidenceInvocation => {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value) || typeof value.id !== "string") return false;
  if (!("startedAt" in value) || typeof value.startedAt !== "number") return false;
  if (!("runtime" in value) || typeof value.runtime !== "object" || value.runtime === null) {
    return false;
  }
  const runtime = value.runtime;
  return (
    "name" in runtime &&
    typeof runtime.name === "string" &&
    "version" in runtime &&
    typeof runtime.version === "string" &&
    "platform" in runtime &&
    typeof runtime.platform === "string" &&
    "arch" in runtime &&
    typeof runtime.arch === "string"
  );
};

const isEvidenceContext = (value: unknown): value is EvidenceContext => {
  if (typeof value !== "object" || value === null) return false;
  return (
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "attemptId" in value &&
    typeof value.attemptId === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "number" &&
    "updatedAt" in value &&
    typeof value.updatedAt === "number" &&
    "invocations" in value &&
    Array.isArray(value.invocations) &&
    value.invocations.every(isEvidenceInvocation)
  );
};

/**
 * Create or join metadata for one attempt-specific run directory. The
 * persisted UUID lets several worker processes contribute correlated evidence
 * without mixing retries.
 */
export const evidenceContextFor = (
  runDir: string,
  requestedAttemptId?: string,
): EvidenceContext => {
  const file = join(runDir, "evidence.json");
  return withArtifactLockSync(file, () => {
    let existing: EvidenceContext | undefined;
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isEvidenceContext(parsed)) {
        throw new Error(`invalid e2e evidence metadata: ${file}`);
      }
      existing = parsed;
    }
    if (existing && requestedAttemptId && existing.attemptId !== requestedAttemptId) {
      throw new Error(
        `e2e evidence attempt mismatch: ${requestedAttemptId} != ${existing.attemptId}`,
      );
    }

    const now = Date.now();
    const invocations = existing?.invocations.some((entry) => entry.id === invocation.id)
      ? existing.invocations
      : [...(existing?.invocations ?? []), invocation];
    const context: EvidenceContext = {
      schemaVersion: 1,
      attemptId: existing?.attemptId ?? requestedAttemptId ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      invocations,
    };
    writeJsonAtomicSync(file, context);
    return context;
  });
};

export const evidenceReferenceFor = (
  runDir: string,
  requestedAttemptId?: string,
): EvidenceReference => ({
  attemptId: evidenceContextFor(runDir, requestedAttemptId).attemptId,
  invocationId: invocation.id,
});
