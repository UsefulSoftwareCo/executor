import { randomBytes } from "node:crypto";

import type { Client, Row } from "@libsql/client";

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
};

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

// A code is redeemable when it exists, is unused, and is unexpired.
export const findRedeemableCode = async (
  client: Client,
  code: string,
): Promise<InviteCodeRow | null> => {
  const result = await client.execute({
    sql: "SELECT * FROM invite_code WHERE code = ? AND used_at IS NULL",
    args: [code.trim().toUpperCase()],
  });
  const raw = result.rows[0];
  if (!raw) return null;
  const row = toRow(raw);
  if (row.expiresAt && Date.parse(row.expiresAt) < Date.now()) return null;
  return row;
};

// Mark a code consumed. The `used_at IS NULL` guard makes this the single-use
// gate even under a race: rowsAffected === 0 means someone redeemed it first.
export const consumeInviteCode = async (
  client: Client,
  code: string,
  by: { usedBy: string; usedByEmail: string },
): Promise<boolean> => {
  const result = await client.execute({
    sql: `UPDATE invite_code SET used_by = ?, used_by_email = ?, used_at = ?
          WHERE code = ? AND used_at IS NULL`,
    args: [by.usedBy, by.usedByEmail, new Date().toISOString(), code.trim().toUpperCase()],
  });
  return result.rowsAffected > 0;
};
