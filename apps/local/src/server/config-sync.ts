// ---------------------------------------------------------------------------
// Boot-time sync — replays sources from executor.jsonc into the executor.
// Plugins upsert so a re-sync on an already-populated DB is a no-op.
// Write-back (DB → file) is handled by the ConfigFileSink passed to each
// plugin in executor.ts.
// ---------------------------------------------------------------------------

import { Cause, Effect, Match } from "effect";
import { join } from "node:path";
import * as fs from "node:fs";
import * as jsonc from "jsonc-parser";

import type { SourceConfig, ExecutorFileConfig, ConfigHeaderValue } from "@executor-js/config";
import { SECRET_REF_PREFIX } from "@executor-js/config";
import type { ScopeId } from "@executor-js/sdk";

import type { LocalExecutor } from "./executor";

// ---------------------------------------------------------------------------
// Header translation: config format → plugin format
// ---------------------------------------------------------------------------

const translateHeader = (
  value: ConfigHeaderValue,
): string | { secretId: string; prefix?: string } => {
  if (typeof value === "string") {
    if (value.startsWith(SECRET_REF_PREFIX)) {
      return { secretId: value.slice(SECRET_REF_PREFIX.length) };
    }
    return value;
  }
  // Object form: { value, prefix? }
  if (typeof value.value === "string" && value.value.startsWith(SECRET_REF_PREFIX)) {
    return {
      secretId: value.value.slice(SECRET_REF_PREFIX.length),
      prefix: value.prefix,
    };
  }
  return value.value;
};

const translateHeaders = (
  headers: Record<string, ConfigHeaderValue> | undefined,
): Record<string, string | { secretId: string; prefix?: string }> | undefined => {
  if (!headers) return undefined;
  const out: Record<string, string | { secretId: string; prefix?: string }> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = translateHeader(v);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Config path resolution
// ---------------------------------------------------------------------------

export const resolveConfigPath = (scopeDir: string): string => join(scopeDir, "executor.jsonc");

// ---------------------------------------------------------------------------
// Load config (sync, no Effect deps — runs at startup)
// ---------------------------------------------------------------------------

const loadConfigSync = (path: string): ExecutorFileConfig | null => {
  if (!fs.existsSync(path)) return null;
  const raw = fs.readFileSync(path, "utf-8");
  const errors: jsonc.ParseError[] = [];
  const parsed = jsonc.parse(raw, errors);
  if (errors.length > 0) {
    console.warn(`[config-sync] Failed to parse ${path}:`, errors);
    return null;
  }
  return parsed as ExecutorFileConfig;
};

// ---------------------------------------------------------------------------
// Sync from config → DB
// ---------------------------------------------------------------------------

const addSourceFromConfig = (
  executor: LocalExecutor,
  targetScope: ScopeId,
  source: SourceConfig,
): Effect.Effect<void, unknown> => {
  return Match.value(source).pipe(
    Match.when({ kind: "openapi" }, (s) =>
      executor.openapi
        .addSpec({
          spec: s.spec,
          scope: targetScope,
          baseUrl: s.baseUrl,
          namespace: s.namespace,
          headers: translateHeaders(s.headers),
        })
        .pipe(Effect.asVoid),
    ),
    Match.when({ kind: "graphql" }, (s) =>
      executor.graphql
        .addSource({
          endpoint: s.endpoint,
          scope: targetScope,
          namespace: s.namespace,
          headers: translateHeaders(s.headers) as Record<string, string> | undefined,
        })
        .pipe(Effect.asVoid),
    ),
    Match.when({ kind: "mcp" }, (s) => {
      if (s.transport === "stdio") {
        return executor.mcp
          .addSource({
            transport: "stdio",
            scope: targetScope,
            name: s.name,
            command: s.command,
            args: s.args ? [...s.args] : undefined,
            env: s.env,
            cwd: s.cwd,
            namespace: s.namespace,
          })
          .pipe(Effect.asVoid);
      }
      return executor.mcp
        .addSource({
          transport: "remote",
          scope: targetScope,
          name: s.name,
          endpoint: s.endpoint,
          remoteTransport: s.remoteTransport,
          queryParams: s.queryParams,
          headers: s.headers,
          namespace: s.namespace,
        })
        .pipe(Effect.asVoid);
    }),
    Match.exhaustive,
  );
};

/**
 * Read executor.jsonc and replay all sources into the executor.
 * Each source is added independently — if one fails, the rest still load.
 */
export const syncFromConfig = (input: {
  readonly executor: LocalExecutor;
  readonly configPath: string;
  readonly targetScope: ScopeId;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { executor, configPath, targetScope } = input;
    const config = loadConfigSync(configPath);
    if (!config?.sources?.length) {
      console.log(`[config-sync] ${configPath} missing or empty, skipping`);
      return;
    }

    console.log(`[config-sync] syncing ${config.sources.length} source(s) from ${configPath}`);

    const results = yield* Effect.forEach(
      config.sources,
      (source) =>
        addSourceFromConfig(executor, targetScope, source).pipe(
          Effect.map(() => true as const),
          Effect.catchCause((cause) => {
            const ns =
              "namespace" in source ? source.namespace : "name" in source ? source.name : "unknown";
            const squashed = Cause.squash(cause);
            const message =
              squashed && typeof squashed === "object" && "message" in squashed
                ? String((squashed as { message: unknown }).message)
                : Cause.pretty(cause);
            console.warn(`[config-sync] Failed to load source "${ns}": ${message}`);
            return Effect.succeed(false as const);
          }),
        ),
      // Serial — bun:sqlite serializes transactions on a single connection,
      // so concurrent addSpec calls race on BEGIN.
      { concurrency: 1 },
    );

    const ok = results.filter(Boolean).length;
    console.log(`[config-sync] ${ok}/${results.length} source(s) synced`);
  });
