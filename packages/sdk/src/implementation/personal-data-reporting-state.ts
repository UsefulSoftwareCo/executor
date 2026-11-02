/** Persisted subject leases, retry deadlines and successful reporting cadence. */
import { Effect, type Crypto } from "effect";
import { StorageError, type AccountId, type OwnerId as OwnerIdType } from "../contracts/shared.ts";
import { query, type Query } from "./database.ts";

const leaseMillis = 5 * 60_000;

export type ReportRow = {
  readonly id: AccountId;
  readonly owner: OwnerIdType;
  readonly clientFingerprint: string;
  readonly credentialGeneration: number;
  readonly status: "active" | "refresh_pending" | "closed";
  readonly encryptedExternalId: Uint8Array | null;
  readonly externalIdFingerprint: string | null;
  readonly retrievedAt: Date | null;
  readonly reportedAt: Date | null;
  readonly cycleDays: number;
  readonly nextReportAt: Date | null;
  readonly retryAt: Date | null;
  readonly retries: number;
  readonly lease: string | null;
  readonly leaseUntil: Date | null;
};

export const delayForCycle = (cycleDays: number, fingerprint: string, now: Date) => {
  // Stable positive jitter spreads a registration's subjects over the cycle without reporting early.
  const jitterHours = Number.parseInt(fingerprint.slice(0, 8), 16) % 6;
  return new Date(now.getTime() + cycleDays * 86_400_000 + jitterHours * 3_600_000);
};

export const makeReportState = (input: { readonly db: Query; readonly crypto: Crypto.Crypto }) => {
  const backoff = (
    row: ReportRow,
    retryAfterSeconds: number | undefined,
    status: number | null,
    now: Date,
  ) => {
    const seconds =
      retryAfterSeconds ??
      (status === 403 || status === 400
        ? 24 * 60 * 60
        : Math.min(24 * 60 * 60, 5 * 60 * 2 ** Math.min(row.retries, 8)));
    return new Date(now.getTime() + Math.ceil(seconds * 1000));
  };

  const updateBySubject = (
    clientFingerprint: string,
    fingerprints: readonly string[],
    set: Partial<Omit<ReportRow, "id" | "owner">>,
    lease?: string,
  ) =>
    query(() =>
      input.db.updateMany("accountReports", {
        where: (b) =>
          b.and(
            b("clientFingerprint", "=", clientFingerprint),
            b("externalIdFingerprint", "in", fingerprints),
            lease === undefined ? true : b("lease", "=", lease),
          ),
        set,
      }),
    );

  const releaseFailedSubject = (
    rows: readonly ReportRow[],
    lease: string,
    now: Date,
    status: number | null,
    retryAfterSeconds?: number,
  ) => {
    const retryAt = backoff(rows[0]!, retryAfterSeconds, status, now);
    const fingerprints = [...new Set(rows.flatMap((row) => row.externalIdFingerprint ?? []))];
    return Effect.forEach(
      fingerprints,
      (fingerprint) =>
        updateBySubject(
          rows[0]!.clientFingerprint,
          [fingerprint],
          {
            retryAt,
            retries: rows[0]!.retries + 1,
            lease: null,
            leaseUntil: null,
          },
          lease,
        ),
      { concurrency: 1, discard: true },
    ).pipe(Effect.asVoid);
  };

  const releaseFailedAccount = (
    row: ReportRow,
    lease: string,
    now: Date,
    status: number | null,
    retryAfterSeconds?: number,
  ) =>
    query(() =>
      input.db.updateMany("accountReports", {
        where: (b) => b.and(b("id", "=", row.id), b("lease", "=", lease)),
        set: {
          retryAt: backoff(row, retryAfterSeconds, status, now),
          retries: row.retries + 1,
          lease: null,
          leaseUntil: null,
        },
      }),
    );

  const claimAccount = (row: ReportRow, now: Date) =>
    Effect.gen(function* () {
      const token = yield* input.crypto.randomUUIDv4.pipe(
        Effect.mapError(() => new StorageError()),
      );
      const leaseUntil = new Date(now.getTime() + leaseMillis);
      yield* query(() =>
        input.db.updateMany("accountReports", {
          where: (b) =>
            b.and(
              b("id", "=", row.id),
              b("status", "=", "refresh_pending"),
              b.or(b("lease", "is", null), b("leaseUntil", "<=", now)),
              b.or(b("retryAt", "is", null), b("retryAt", "<=", now)),
            ),
          set: { lease: token, leaseUntil },
        }),
      );
      const claimed = yield* query(() =>
        input.db.findFirst("accountReports", {
          where: (b) => b.and(b("id", "=", row.id), b("lease", "=", token)),
        }),
      );
      return claimed === null ? undefined : { row: claimed as ReportRow, token };
    });

  const claimSubjects = (clientFingerprint: string, fingerprints: readonly string[], now: Date) =>
    Effect.gen(function* () {
      const token = yield* input.crypto.randomUUIDv4.pipe(
        Effect.mapError(() => new StorageError()),
      );
      const leaseUntil = new Date(now.getTime() + leaseMillis);
      const claimable: string[] = [];
      for (const fingerprint of fingerprints) {
        const rows = (yield* query(() =>
          input.db.findMany("accountReports", {
            where: (b) =>
              b.and(
                b("clientFingerprint", "=", clientFingerprint),
                b("externalIdFingerprint", "=", fingerprint),
                b("status", "=", "active"),
              ),
          }),
        )) as ReportRow[];
        if (
          rows.length === 0 ||
          rows.some((row) => row.lease !== null && row.leaseUntil !== null && row.leaseUntil > now)
        )
          continue;
        yield* query(() =>
          input.db.updateMany("accountReports", {
            where: (b) =>
              b.and(
                b("clientFingerprint", "=", clientFingerprint),
                b("externalIdFingerprint", "=", fingerprint),
                b("status", "=", "active"),
                b.or(b("lease", "is", null), b("leaseUntil", "<=", now)),
              ),
            set: { lease: token, leaseUntil },
          }),
        );
        const claimed = (yield* query(() =>
          input.db.findMany("accountReports", {
            where: (b) =>
              b.and(
                b("clientFingerprint", "=", clientFingerprint),
                b("externalIdFingerprint", "=", fingerprint),
                b("status", "=", "active"),
              ),
          }),
        )) as ReportRow[];
        if (claimed.length > 0 && claimed.every((row) => row.lease === token))
          claimable.push(fingerprint);
        else
          yield* query(() =>
            input.db.updateMany("accountReports", {
              where: (b) =>
                b.and(
                  b("clientFingerprint", "=", clientFingerprint),
                  b("externalIdFingerprint", "=", fingerprint),
                  b("lease", "=", token),
                ),
              set: { lease: null, leaseUntil: null },
            }),
          );
      }
      return { token, leaseUntil, fingerprints: claimable };
    });

  const updateReported = (
    clientFingerprint: string,
    fingerprints: readonly string[],
    lease: string,
    cycleDays: number,
    now: Date,
  ) =>
    Effect.forEach(
      fingerprints,
      (fingerprint) =>
        updateBySubject(
          clientFingerprint,
          [fingerprint],
          {
            status: "active",
            reportedAt: now,
            cycleDays,
            nextReportAt: delayForCycle(cycleDays, fingerprint, now),
            retryAt: null,
            retries: 0,
            lease: null,
            leaseUntil: null,
          },
          lease,
        ),
      { concurrency: 1, discard: true },
    ).pipe(Effect.asVoid);

  return {
    updateBySubject,
    releaseFailedSubject,
    releaseFailedAccount,
    claimAccount,
    claimSubjects,
    updateReported,
  };
};
