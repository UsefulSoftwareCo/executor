/**
 * Tiny desktop-main copy of the local bearer-token file contract.
 *
 * Keep this module free of @executor-js/local imports. The Electron main
 * process only needs to mint/read/rotate auth.json so it can pass the bearer
 * to the sidecar and inject it into the renderer session; importing the local
 * server package here drags the whole server/native LibSQL graph into app.asar.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const resolveExecutorDataDir = (): string =>
  resolve(process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor"));

const serverControlDir = (dataDir: string): string => join(dataDir, "server-control");

const localAuthTokenPath = (dataDir: string = resolveExecutorDataDir()): string =>
  join(serverControlDir(dataDir), "auth.json");

const mintToken = (): string => randomBytes(32).toString("base64url");

const readToken = (path: string): string | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: optional on-disk secret may be absent or malformed
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: auth.json is a tiny local boot secret outside the Effect graph
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
  writeFileSync(path, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
};

export const loadOrMintLocalAuthToken = (dataDir: string = resolveExecutorDataDir()): string =>
  readToken(localAuthTokenPath(dataDir)) ?? writeToken(dataDir, mintToken());

export const rotateLocalAuthToken = (dataDir: string = resolveExecutorDataDir()): string =>
  writeToken(dataDir, mintToken());
