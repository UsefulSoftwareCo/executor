import { randomBytes } from "node:crypto";

import type { Client, Row } from "@libsql/client";
import type { BetterAuthPlugin, DBTransactionAdapter } from "better-auth";

// ---------------------------------------------------------------------------
// Invite codes — the join mechanism for a single-tenant instance.
//
// The instance closes open signup (the `user.create` gate in better-auth.ts)
// and lets people in ONLY by redeeming a per-user, single-use code. The code is
// the bearer credential: whoever holds it can self-register (with their own
// name/email/password) and lands as a real `member` of the one org. Unlike
// Better Auth's `invitation` table, a code is NOT bound to an email — the admin
// hands out a link, not an address.
//
// Stored in a raw libSQL table managed here (CREATE TABLE IF NOT EXISTS on
// boot), the same hand-rolled-SQL pattern the org/admin seed uses against the
// shared libSQL file. It is intentionally independent of both the fumadb
// versioned schema and Better Auth's migrator.
// ---------------------------------------------------------------------------

export type InviteRole = "admin" | "member";

export interface InviteCodeRow {
  readonly id: string;
  readonly code: string;
  readonly role: InviteRole;
  readonly label: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly usedBy: string | null;
  readonly usedByEmail: string | null;
  readonly usedAt: string | null;
}

export const signupClaimPlugin = {
  id: "executor-signup-claims",
  schema: {
    inviteCode: {
      modelName: "invite_code",
      disableMigration: true,
      fields: {
        code: { type: "string", unique: true },
        role: { type: "string" },
        label: { type: "string", required: false },
        createdBy: { type: "string", fieldName: "created_by" },
        createdAt: { type: "date", fieldName: "created_at" },
        expiresAt: { type: "date", required: false, fieldName: "expires_at" },
        usedBy: { type: "string", required: false, fieldName: "used_by" },
        usedByEmail: { type: "string", required: false, fieldName: "used_by_email" },
        usedAt: { type: "date", required: false, fieldName: "used_at" },
      },
    },
    signupClaim: {
      modelName: "signup_claim",
      disableMigration: true,
      fields: {
        organizationId: {
          type: "string",
          unique: true,
          fieldName: "organization_id",
          references: { model: "organization", field: "id", onDelete: "cascade" },
        },
        claimedBy: { type: "string", required: false, fieldName: "claimed_by" },
        claimedEmail: { type: "string", required: false, fieldName: "claimed_email" },
        claimedAt: { type: "date", required: false, fieldName: "claimed_at" },
      },
    },
  },
} satisfies BetterAuthPlugin;

// Unambiguous alphabet (no 0/O/1/I/l) so a code is easy to read and type.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// 12 chars grouped as XXXX-XXXX-XXXX — easy to read aloud or paste.
const generateCode = (): string => {
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)]
    .map((g) => g.join(""))
    .join("-");
};

const toRow = (raw: Row): InviteCodeRow => ({
  id: String(raw.id),
  code: String(raw.code),
  role: raw.role === "admin" ? "admin" : "member",
  label: raw.label == null ? null : String(raw.label),
  createdBy: String(raw.created_by),
  createdAt: String(raw.created_at),
  expiresAt: raw.expires_at == null ? null : String(raw.expires_at),
  usedBy: raw.used_by == null ? null : String(raw.used_by),
  usedByEmail: raw.used_by_email == null ? null : String(raw.used_by_email),
  usedAt: raw.used_at == null ? null : String(raw.used_at),
});

export const ensureInviteCodeTable = async (client: Client): Promise<void> => {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS invite_code (
      id            TEXT PRIMARY KEY,
      code          TEXT NOT NULL UNIQUE,
      role          TEXT NOT NULL DEFAULT 'member',
      label         TEXT,
      created_by    TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      expires_at    TEXT,
      used_by       TEXT,
      used_by_email TEXT,
      used_at       TEXT
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS signup_claim (
      id              TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL UNIQUE REFERENCES organization(id) ON DELETE CASCADE,
      claimed_by      TEXT,
      claimed_email   TEXT,
      claimed_at      TEXT
    )
  `);
};

export const ensureOrganizationSignupClaim = async (
  client: Client,
  input: {
    readonly organizationId: string;
    readonly claimedBy?: string | null;
    readonly claimedEmail?: string | null;
  },
) => {
  const claimedAt = input.claimedBy ? new Date().toISOString() : null;
  await client.execute({
    sql: `INSERT INTO signup_claim
            (id, organization_id, claimed_by, claimed_email, claimed_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(organization_id) DO UPDATE SET
            claimed_by = COALESCE(signup_claim.claimed_by, excluded.claimed_by),
            claimed_email = COALESCE(signup_claim.claimed_email, excluded.claimed_email),
            claimed_at = COALESCE(signup_claim.claimed_at, excluded.claimed_at)`,
    args: [
      input.organizationId,
      input.organizationId,
      input.claimedBy ?? null,
      input.claimedEmail ?? null,
      claimedAt,
    ],
  });
};

const pendingClaimId = () => `pending:${randomBytes(16).toString("hex")}`;

export const reserveFirstOwner = async (
  adapter: DBTransactionAdapter,
  organizationId: string,
  email: string,
) => {
  const claimId = pendingClaimId();
  const claimed = await adapter.updateMany({
    model: "signupClaim",
    where: [
      { field: "organizationId", value: organizationId },
      { field: "claimedAt", value: null },
    ],
    update: { claimedBy: claimId, claimedEmail: email, claimedAt: new Date() },
  });
  return claimed === 1 ? { kind: "owner" as const, claimId, email } : null;
};

export const finalizeFirstOwner = async (
  adapter: DBTransactionAdapter,
  organizationId: string,
  claimId: string,
  user: { readonly id: string; readonly email: string },
) =>
  (await adapter.updateMany({
    model: "signupClaim",
    where: [
      { field: "organizationId", value: organizationId },
      { field: "claimedBy", value: claimId },
    ],
    update: { claimedBy: user.id, claimedEmail: user.email },
  })) === 1;

export const reserveInviteCode = async (
  adapter: DBTransactionAdapter,
  code: string,
  email: string,
) => {
  const normalizedCode = code.trim().toUpperCase();
  const claimId = pendingClaimId();
  const claimedAt = new Date();
  const claimed = await adapter.updateMany({
    model: "inviteCode",
    where: [
      { field: "code", value: normalizedCode },
      { field: "usedAt", value: null },
      { field: "expiresAt", value: null, connector: "OR" },
      { field: "expiresAt", value: claimedAt, operator: "gt", connector: "OR" },
    ],
    update: { usedBy: claimId, usedByEmail: email, usedAt: claimedAt },
  });
  if (claimed !== 1) return null;

  const row = await adapter.findOne<{ readonly role: string }>({
    model: "inviteCode",
    where: [
      { field: "code", value: normalizedCode },
      { field: "usedBy", value: claimId },
    ],
  });
  if (!row) return null;
  return {
    kind: "invite" as const,
    claimId,
    code: normalizedCode,
    email,
    role: row.role === "admin" ? ("admin" as const) : ("member" as const),
  };
};

export const finalizeInviteCode = async (
  adapter: DBTransactionAdapter,
  reservation: { readonly code: string; readonly claimId: string },
  user: { readonly id: string; readonly email: string },
) =>
  (await adapter.updateMany({
    model: "inviteCode",
    where: [
      { field: "code", value: reservation.code },
      { field: "usedBy", value: reservation.claimId },
    ],
    update: { usedBy: user.id, usedByEmail: user.email },
  })) === 1;

export interface CreateInviteCodeInput {
  readonly createdBy: string;
  readonly role?: InviteRole;
  readonly label?: string | null;
  readonly expiresAt?: string | null;
}

export const createInviteCode = async (
  client: Client,
  input: CreateInviteCodeInput,
): Promise<InviteCodeRow> => {
  const row: InviteCodeRow = {
    id: randomBytes(16).toString("hex"),
    code: generateCode(),
    role: input.role ?? "member",
    label: input.label ?? null,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt ?? null,
    usedBy: null,
    usedByEmail: null,
    usedAt: null,
  };
  await client.execute({
    sql: `INSERT INTO invite_code (id, code, role, label, created_by, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [row.id, row.code, row.role, row.label, row.createdBy, row.createdAt, row.expiresAt],
  });
  return row;
};

// Newest first; the admin page renders pending + used together.
export const listInviteCodes = async (client: Client): Promise<readonly InviteCodeRow[]> => {
  const result = await client.execute("SELECT * FROM invite_code ORDER BY created_at DESC");
  return result.rows.map(toRow);
};

// Revoke = delete a pending (unused) code. Used codes are kept as an audit row
// (their membership already exists); deleting one would not remove the member.
export const revokeInviteCode = async (client: Client, id: string): Promise<void> => {
  await client.execute({
    sql: "DELETE FROM invite_code WHERE id = ? AND used_at IS NULL",
    args: [id],
  });
};
