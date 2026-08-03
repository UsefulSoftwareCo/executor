// ---------------------------------------------------------------------------
// ConfigFileSink — best-effort write-back of integration changes to executor.jsonc.
//
// Plugins (openapi, graphql, mcp) call `sink.upsertIntegration` after their DB
// writes so the committable file stays in sync with runtime state. Errors
// are logged and swallowed — a failed file write must never fail a DB
// mutation, and the next successful mutation (or a boot-time sync) will
// eventually reconcile.
//
// The FileSystem layer is injected so library code here doesn't pick a
// platform binding. The host app provides NodeFileSystem (or BunFileSystem).
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type { Layer } from "effect";
import type { FileSystem } from "effect";

import { SECRET_REF_PREFIX, type ConfigHeaderValue, type IntegrationConfig } from "./schema";
import { addIntegrationToConfig, removeIntegrationFromConfig } from "./write";

// Translate a plugin-side header value (`{ secretId, prefix? }` for secret
// refs) into the config file's `secret-public-ref:<id>` string form.
type PluginHeaderValue = string | { secretId: string; prefix?: string };

export const headerToConfigValue = (value: PluginHeaderValue): ConfigHeaderValue => {
  if (typeof value === "string") return value;
  const ref = `${SECRET_REF_PREFIX}${value.secretId}`;
  return value.prefix ? { value: ref, prefix: value.prefix } : ref;
};

export const headersToConfigValues = (
  headers: Record<string, PluginHeaderValue> | undefined,
): Record<string, ConfigHeaderValue> | undefined => {
  if (!headers) return undefined;
  const out: Record<string, ConfigHeaderValue> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = headerToConfigValue(v);
  return out;
};

export interface ConfigFileSink {
  readonly upsertIntegration: (integration: IntegrationConfig) => Effect.Effect<void>;
  readonly removeIntegration: (namespace: string) => Effect.Effect<void>;
}

export interface ConfigFileSinkOptions {
  readonly path: string;
  readonly fsLayer: Layer.Layer<FileSystem.FileSystem>;
  /** Called when a file operation fails. Defaults to console.warn. */
  readonly onError?: (op: "upsert" | "remove", err: unknown) => void;
}

const defaultOnError = (op: "upsert" | "remove", err: unknown): void => {
  console.warn(`[config-sink] ${op} failed`, err);
};

export const makeFileConfigSink = (options: ConfigFileSinkOptions): ConfigFileSink => {
  const { path, fsLayer, onError = defaultOnError } = options;

  return {
    upsertIntegration: (integration) =>
      addIntegrationToConfig(path, integration).pipe(
        Effect.provide(fsLayer),
        Effect.catch((err: unknown) => Effect.sync(() => onError("upsert", err))),
      ),

    removeIntegration: (namespace) =>
      removeIntegrationFromConfig(path, namespace).pipe(
        Effect.provide(fsLayer),
        Effect.catch((err: unknown) => Effect.sync(() => onError("remove", err))),
      ),
  };
};
