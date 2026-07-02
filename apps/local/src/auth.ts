/**
 * The local bearer token — the single auth credential for the local daemon.
 *
 * Local is single-user: one human, one machine, one executor scoped to the
 * working directory. The token is the ONE credential that gates every surface
 * (`/api`, `/mcp`, the MCP approval + OAuth await endpoints). It is minted once
 * on first run and reused forever so AI-client MCP configs stay valid across
 * restarts, and it is the only secret stored at rest.
 *
 * Storage is a single file, `<dataDir>/server-control/auth.json`, written with
 * mode `0600` (owner read/write only). `dataDir` resolves exactly like the
 * server manifest path: `EXECUTOR_DATA_DIR` if set, otherwise `~/.executor`.
 * This is the source of truth; the runtime server manifest (`server.json`)
 * carries a copy of the token for live consumers but does not own it.
 *
 * Deliberately plain `node:fs` (sync) with no Effect dependency so the Bun
 * serve shell (`serve.ts`) and the Electron main process can both call it
 * during boot without a runtime.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/** Resolve the executor data directory — `EXECUTOR_DATA_DIR` or `~/.executor`. */
export const resolveExecutorDataDir = (): string =>
  resolve(process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor"));

const serverControlDir = (dataDir: string): string => join(dataDir, "server-control");

/** Absolute path to the auth-token file for a data directory. */
export const localAuthTokenPath = (dataDir: string = resolveExecutorDataDir()): string =>
  join(serverControlDir(dataDir), "auth.json");

const mintToken = (): string => randomBytes(32).toString("base64url");

const readToken = (path: string): string | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: reading an optional on-disk secret file that may be absent or malformed
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: the secret file is a tiny {"token"} blob outside the Effect graph (used by the plain Bun/Electron boot path)
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { readonly token?: unknown };
    return typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
  } catch {
    return null;
  }
};

const writeToken = (dataDir: string, token: string): string => {
  const dir = serverControlDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "auth.json");
  // `mode` only applies when the file is created; chmod afterwards covers the
  // case where an older world-readable file already exists.
  writeFileSync(path, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
};

/**
 * Return the stable local bearer token, minting and persisting one on first
 * call. Idempotent: subsequent calls return the same token.
 */
export const loadOrMintLocalAuthToken = (dataDir: string = resolveExecutorDataDir()): string =>
  readToken(localAuthTokenPath(dataDir)) ?? writeToken(dataDir, mintToken());

/**
 * Rotate the local bearer token: mint a fresh one and overwrite the file.
 * Callers must re-advertise it (manifest, header injection, MCP client configs)
 * and restart any running server so the new token takes effect.
 */
export const rotateLocalAuthToken = (dataDir: string = resolveExecutorDataDir()): string =>
  writeToken(dataDir, mintToken());
