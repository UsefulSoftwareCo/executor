import { randomUUID } from "node:crypto";

import type { Client } from "@libsql/client";

// Remote self-host deployments can cold-start several containers against the
// same database. Schema/data migrations and first-run auth seeding must remain
// single-writer, so remote boots take a short, renewable database lease around
// that whole critical section. A crashed container's lease expires and another
// container can recover without operator intervention.

const LOCK_TABLE = "executor_boot_lock";
const LOCK_NAME = "startup";
const LEASE_EXPIRY_SAFETY_MS = 1_000;
const TAKEOVER_GRACE_MS = 2_000;

export interface SelfHostBootLockOptions {
  readonly leaseMs?: number;
  readonly pollMs?: number;
  readonly takeoverGraceMs?: number;
  readonly waitTimeoutMs?: number;
}

export class SelfHostBootLockError extends Error {
  override readonly name = "SelfHostBootLockError";
}

const terminateBeforeLeaseExpiry = (cause: unknown): never => {
  console.error(
    "[executor] Cannot safely renew the shared database startup lock; terminating this container before another boot can acquire it.",
    cause,
  );
  // oxlint-disable-next-line no-process-exit -- boundary: fail-stop preserves exclusive migration ownership when the distributed lease cannot be renewed
  process.exit(1);
};

const sleep = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const isDatabaseBusy = (cause: unknown): boolean => {
  let current: unknown = cause;
  const seen = new Set<object>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && (current as { readonly code?: unknown }).code === "SQLITE_BUSY") {
      return true;
    }
    // oxlint-disable-next-line executor/no-instanceof-error -- boundary: libSQL exposes driver failures as unknown values and SQLITE_BUSY is identified from the adapter's Error chain
    if (current instanceof Error) {
      if (/SQLITE_BUSY|database is locked/i.test(current.message)) return true;
      current = current.cause;
      continue;
    }
    return false;
  }
  return false;
};

export const withSelfHostBootLock = async <T>(
  client: Pick<Client, "execute">,
  run: () => Promise<T>,
  options: SelfHostBootLockOptions = {},
): Promise<T> => {
  const leaseMs = options.leaseMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  const takeoverGraceMs = options.takeoverGraceMs ?? TAKEOVER_GRACE_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? 120_000;
  const leaseExpirySafetyMs = Math.min(
    LEASE_EXPIRY_SAFETY_MS,
    Math.max(1, Math.floor(leaseMs / 4)),
    Math.max(1, Math.floor(takeoverGraceMs / 4)),
  );
  const owner = randomUUID();
  const waitDeadline = Date.now() + waitTimeoutMs;

  await client.execute(
    `CREATE TABLE IF NOT EXISTS ${LOCK_TABLE} (` +
      "name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  );

  let leaseExpiresAt = 0;
  let observedExpiredLease:
    | { readonly owner: string; readonly expiresAt: number; observedAt: number }
    | undefined;
  while (leaseExpiresAt === 0) {
    const now = Date.now();
    const candidateExpiry = now + leaseMs;
    const existing = await client.execute({
      sql: `SELECT owner, expires_at FROM ${LOCK_TABLE} WHERE name = ?`,
      args: [LOCK_NAME],
    });
    const row = existing.rows[0];

    if (!row) {
      const acquired = await client.execute({
        sql: `INSERT INTO ${LOCK_TABLE} (name, owner, expires_at) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING`,
        args: [LOCK_NAME, owner, candidateExpiry],
      });
      if (acquired.rowsAffected > 0) {
        leaseExpiresAt = candidateExpiry;
        break;
      }
      observedExpiredLease = undefined;
    } else {
      const currentOwner = typeof row.owner === "string" ? row.owner : "";
      const currentExpiry = Number(row.expires_at);
      if (!currentOwner || !Number.isFinite(currentExpiry)) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: malformed lock state cannot safely coordinate startup
        throw new SelfHostBootLockError("The shared database startup lock is malformed");
      }

      if (currentExpiry > now) {
        observedExpiredLease = undefined;
      } else {
        if (
          !observedExpiredLease ||
          observedExpiredLease.owner !== currentOwner ||
          observedExpiredLease.expiresAt !== currentExpiry
        ) {
          observedExpiredLease = {
            owner: currentOwner,
            expiresAt: currentExpiry,
            observedAt: now,
          };
        }

        const expiredLease = observedExpiredLease;
        if (now - expiredLease.observedAt >= takeoverGraceMs) {
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a current owner may temporarily hold SQLite's writer lock while migrating
          try {
            const acquired = await client.execute({
              sql:
                `UPDATE ${LOCK_TABLE} SET owner = ?, expires_at = ? ` +
                "WHERE name = ? AND owner = ? AND expires_at = ?",
              args: [owner, candidateExpiry, LOCK_NAME, currentOwner, currentExpiry],
            });
            if (acquired.rowsAffected > 0) {
              leaseExpiresAt = candidateExpiry;
              break;
            }
            observedExpiredLease = undefined;
          } catch (cause) {
            // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: non-busy libSQL adapter failures must retain their original type and stack
            if (!isDatabaseBusy(cause)) throw cause;
            // The current boot is still inside a write transaction. Start a
            // fresh grace window when the writer becomes reachable again so
            // its queued heartbeat has priority over takeover.
            expiredLease.observedAt = Date.now();
          }
        }
      }
    }
    if (now >= waitDeadline) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: startup cannot continue without exclusive migration and seed ownership
      throw new SelfHostBootLockError(
        `Timed out after ${waitTimeoutMs}ms waiting for the shared database startup lock`,
      );
    }
    await sleep(pollMs);
  }

  let stopped = false;
  let latestRenewalError: unknown;
  let renewal = Promise.resolve();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  const armExpiryGuard = (safetyDeadline = leaseExpiresAt + takeoverGraceMs) => {
    clearTimeout(expiryTimer);
    const durationMs = Math.max(0, safetyDeadline - Date.now() - leaseExpirySafetyMs);
    expiryTimer = setTimeout(
      () =>
        terminateBeforeLeaseExpiry(
          latestRenewalError ??
            new SelfHostBootLockError("The shared database startup lease expired"),
        ),
      durationMs,
    );
  };
  armExpiryGuard();

  const renewEveryMs = Math.max(1, Math.floor(leaseMs / 3));
  const scheduleRenewal = (delayMs: number) => {
    if (stopped) return;
    heartbeatTimer = setTimeout(() => {
      renewal = (async () => {
        const nextExpiry = Date.now() + leaseMs;
        const renewed = await client.execute({
          sql: `UPDATE ${LOCK_TABLE} SET expires_at = ? WHERE name = ? AND owner = ?`,
          args: [nextExpiry, LOCK_NAME, owner],
        });
        if (renewed.rowsAffected === 0) {
          terminateBeforeLeaseExpiry(
            new SelfHostBootLockError("Lost the shared database startup lock during boot"),
          );
        }
        leaseExpiresAt = nextExpiry;
        latestRenewalError = undefined;
        armExpiryGuard();
      })().then(
        () => scheduleRenewal(renewEveryMs),
        (cause: unknown) => {
          latestRenewalError = cause;
          if (isDatabaseBusy(cause)) {
            // A SQLite writer lock also blocks takeover. Keep retrying quickly,
            // and mirror the grace window contenders must observe after their
            // own failed takeover write.
            armExpiryGuard(Date.now() + takeoverGraceMs);
          }
          scheduleRenewal(pollMs);
        },
      );
    }, delayMs);
    heartbeatTimer.unref?.();
  };
  scheduleRenewal(renewEveryMs);

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the database lease must always be released when boot succeeds or fails
  try {
    return await run();
  } finally {
    stopped = true;
    clearTimeout(heartbeatTimer);
    clearTimeout(expiryTimer);
    await renewal;
    await client.execute({
      sql: `DELETE FROM ${LOCK_TABLE} WHERE name = ? AND owner = ?`,
      args: [LOCK_NAME, owner],
    });
  }
};
