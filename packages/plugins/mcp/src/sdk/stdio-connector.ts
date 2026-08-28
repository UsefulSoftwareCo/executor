// ---------------------------------------------------------------------------
// Stdio transport factory — loaded only on demand
// ---------------------------------------------------------------------------
//
// Kept in its own module so `connection.ts` never imports it eagerly at
// module load. The v2 `@modelcontextprotocol/client/stdio` entry still eagerly
// evaluates Node-only process/stream imports and `cross-spawn` (which loads
// `node:child_process`); under `@cloudflare/vitest-pool-workers`
// that crashes workerd at module instantiation with SIGSEGV (prod bundles
// tree-shake it away when `dangerouslyAllowStdioMCP: false`, tests do not).
//
// Callers that actually need stdio transport reach it via a dynamic import
// in `connection.ts`. Remote-only consumers (cloud/marketing) never execute
// the import and therefore never touch `node:child_process`.
// ---------------------------------------------------------------------------

import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

export type StdioTransportConfig = {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
  readonly cwd?: string;
};

/**
 * Host variables a stdio server inherits, on top of the SDK's own safe-list.
 *
 * Same reasoning and same list as the TLS pass-through `service install` bakes
 * into a supervised unit's minimal environment (`apps/cli/src/service.ts`): a
 * stdio server sits behind the same corporate proxy and the same intercepting
 * CA as the process that spawned it, and those paths commonly live outside the
 * OS trust store. Dropping them makes every HTTPS call from every stdio server
 * fail on such a network. None of them carries a credential.
 *
 * Deliberately short and closed. Anything else a server needs — an API key
 * above all — is declared on the source config's `env`, which is the mechanism
 * that already exists for exactly that, and which wins on a key collision.
 */
const inheritedEnvKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  // Lowercase spellings are not aliases: libcurl and most Unix tooling read
  // these, while Node reads the uppercase ones. Both are in real use.
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/** Read at spawn time, not module load: the host's proxy configuration can be
 *  set after this module is first imported. */
const inheritedEnv = (): Record<string, string> =>
  Object.fromEntries(
    inheritedEnvKeys.flatMap((key) => {
      const value = process.env[key];
      return value ? [[key, value] as const] : [];
    }),
  );

/**
 * Combine the inherited allowlist with the source config's declared `env`,
 * using the key identity the target platform actually has.
 *
 * On Windows an environment key is case-insensitive: `Path` and `PATH` name one
 * variable. A JavaScript spread is case-sensitive on every platform, so a plain
 * merge can emit two spellings of the same variable — inherited `HTTP_PROXY`
 * beside a declared `http_proxy`, or the SDK's `PATH` beside a declared `Path`.
 * Both then reach the child's environment block, and the child reads whichever
 * Windows resolves first rather than the one the config declared. Precedence
 * that reads correctly in the source is silently lost at the boundary.
 *
 * So on `win32` this merges by case-insensitive key identity. The declared env
 * still wins, and the losing spelling is dropped instead of travelling beside
 * the winner. A key that collides with one the SDK sets is emitted with the
 * SDK's spelling, because the SDK spreads its own safe-list underneath this
 * result: matching its spelling replaces that entry, while a different spelling
 * would only add an alias next to it.
 *
 * On every other platform the keys are genuinely case-sensitive, and this is a
 * plain merge.
 */
export const mergeStdioEnv = ({
  platform,
  inherited,
  declared,
  sdkKeys = [],
}: {
  readonly platform: NodeJS.Platform;
  readonly inherited: Record<string, string>;
  readonly declared?: Record<string, string>;
  /** Keys the SDK's own safe-list will place underneath this result. */
  readonly sdkKeys?: ReadonlyArray<string>;
}): Record<string, string> => {
  if (platform !== "win32") return { ...inherited, ...declared };

  const sdkSpelling = new Map(sdkKeys.map((key) => [key.toLowerCase(), key] as const));
  // Keyed by the case-insensitive identity; insertion order follows first
  // sight of a variable, and a later source overwrites the entry in place.
  const merged = new Map<string, readonly [string, string]>();

  for (const source of [inherited, declared]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      const identity = key.toLowerCase();
      merged.set(identity, [sdkSpelling.get(identity) ?? key, value]);
    }
  }

  return Object.fromEntries(merged.values());
};

export const createStdioTransport = (config: StdioTransportConfig) =>
  new StdioClientTransport({
    command: config.command,
    args: config.args ? [...config.args] : undefined,
    // Pass the declared env plus the infrastructure allowlist above, and
    // nothing else. The SDK merges this over `getDefaultEnvironment()`, a
    // sudo-style safe-list (HOME, LOGNAME, PATH, SHELL, TERM, USER) that
    // deliberately excludes everything else and skips function-shaped values
    // as a security risk.
    //
    // Spreading `process.env` here did not add to that safe-list, it defeated
    // it: the child received every variable this process holds, which for a
    // server that spawns one includes `EXECUTOR_SECRET_KEY` (the key that
    // decrypts the secret store), `EXECUTOR_AUTH_TOKEN`, `DATABASE_URL` and
    // whatever else the operator exported.
    env: mergeStdioEnv({
      platform: process.platform,
      inherited: inheritedEnv(),
      declared: config.env,
      sdkKeys: Object.keys(getDefaultEnvironment()),
    }),
    cwd: config.cwd,
  });
