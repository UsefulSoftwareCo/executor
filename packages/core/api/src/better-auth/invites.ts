import { randomBytes } from "node:crypto";
import type { BetterAuthDbClient } from "./shared";

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

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const generateCode = (): string => {
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)]
    .map((g) => g.join(""))
    .join("-");
};

const toRow = (raw: any): InviteCodeRow => ({
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

export const ensureInviteCodeTable = async (client: BetterAuthDbClient): Promise<void> => {
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
  client: BetterAuthDbClient,
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
  await client.execute(
    `INSERT INTO invite_code (id, code, role, label, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.code, row.role, row.label, row.createdBy, row.createdAt, row.expiresAt],
  );
  return row;
};

export const listInviteCodes = async (
  client: BetterAuthDbClient,
): Promise<readonly InviteCodeRow[]> => {
  const result = await client.execute("SELECT * FROM invite_code ORDER BY created_at DESC");
  return result.rows.map(toRow);
};

export const revokeInviteCode = async (client: BetterAuthDbClient, id: string): Promise<void> => {
  await client.execute("DELETE FROM invite_code WHERE id = ? AND used_at IS NULL", [id]);
};

export const findRedeemableCode = async (
  client: BetterAuthDbClient,
  code: string,
): Promise<InviteCodeRow | null> => {
  const result = await client.execute(
    "SELECT * FROM invite_code WHERE code = ? AND used_at IS NULL",
    [code.trim().toUpperCase()],
  );
  const raw = result.rows[0];
  if (!raw) return null;
  const row = toRow(raw);
  if (row.expiresAt && Date.parse(row.expiresAt) < Date.now()) return null;
  return row;
};

export const consumeInviteCode = async (
  client: BetterAuthDbClient,
  code: string,
  by: { usedBy: string; usedByEmail: string },
): Promise<boolean> => {
  const result = await client.execute(
    `UPDATE invite_code SET used_by = ?, used_by_email = ?, used_at = ?
     WHERE code = ? AND used_at IS NULL`,
    [by.usedBy, by.usedByEmail, new Date().toISOString(), code.trim().toUpperCase()],
  );
  return (result.rowsAffected ?? 0) > 0;
};
