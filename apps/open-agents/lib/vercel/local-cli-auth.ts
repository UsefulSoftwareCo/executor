import "server-only";

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isLocalDevelopmentAuthEnabled } from "@/lib/session/local-development-session";

interface LocalVercelAuthInfo {
  token: string;
  expiresAt: number;
  externalId: string;
}

interface VercelCliAuthFile {
  token?: unknown;
  expiresAt?: unknown;
  userId?: unknown;
}

function parseAuthFile(value: unknown): LocalVercelAuthInfo | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const authFile = value as VercelCliAuthFile;
  if (typeof authFile.token !== "string" || !authFile.token) {
    return null;
  }

  const expiresAt =
    typeof authFile.expiresAt === "number"
      ? authFile.expiresAt
      : Math.floor(Date.now() / 1000) + 3600;

  if (expiresAt <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  return {
    token: authFile.token,
    expiresAt,
    externalId: typeof authFile.userId === "string" ? authFile.userId : "local",
  };
}

export async function getLocalVercelAuthInfo(): Promise<LocalVercelAuthInfo | null> {
  if (!isLocalDevelopmentAuthEnabled()) {
    return null;
  }

  if (process.env.VERCEL_TOKEN) {
    return {
      token: process.env.VERCEL_TOKEN,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      externalId: process.env.OPEN_AGENTS_LOCAL_USER_ID ?? "local",
    };
  }

  try {
    const contents = await readFile(
      join(homedir(), ".local/share/com.vercel.cli/auth.json"),
      "utf-8",
    );
    return parseAuthFile(JSON.parse(contents));
  } catch {
    return null;
  }
}
