import { Effect } from "effect";
import { FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as jsonc from "jsonc-parser";
import type { IntegrationConfig, ExecutorFileConfig } from "./schema";

export class ConfigWriteError {
  readonly _tag = "ConfigWriteError";
  constructor(
    readonly path: string,
    readonly cause: unknown,
  ) {}
}

const FORMATTING: jsonc.FormattingOptions = {
  tabSize: 2,
  insertSpaces: true,
  eol: "\n",
};

const DEFAULT_CONFIG = `{
  "integrations": []
}
`;

/** Read the raw JSONC text from a config file, or create a default one. */
const readOrCreate = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<string, PlatformError> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(path);
    if (exists) return yield* fs.readFileString(path);
    yield* fs.writeFileString(path, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  });

/**
 * Add an integration entry to the config file. Creates the file if it doesn't exist.
 * Preserves existing comments and formatting.
 */
export const addIntegrationToConfig = (
  path: string,
  integration: IntegrationConfig,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let text = yield* readOrCreate(fs, path);

    // Ensure "integrations" array exists
    let tree = jsonc.parseTree(text);
    let integrationsNode = tree ? jsonc.findNodeAtLocation(tree, ["integrations"]) : undefined;

    if (!integrationsNode) {
      const edits = jsonc.modify(text, ["integrations"], [integration], {
        formattingOptions: FORMATTING,
      });
      text = jsonc.applyEdits(text, edits);
    } else {
      // Remove existing entry with same namespace (if any) to avoid duplicates
      const ns = "namespace" in integration ? integration.namespace : undefined;
      if (ns && integrationsNode.children) {
        for (let i = integrationsNode.children.length - 1; i >= 0; i--) {
          const child = integrationsNode.children[i]!;
          const nsNode = jsonc.findNodeAtLocation(child, ["namespace"]);
          if (nsNode && jsonc.getNodeValue(nsNode) === ns) {
            const edits = jsonc.modify(text, ["integrations", i], undefined, {
              formattingOptions: FORMATTING,
            });
            text = jsonc.applyEdits(text, edits);
          }
        }
        // Re-parse after removals
        tree = jsonc.parseTree(text);
        integrationsNode = tree ? jsonc.findNodeAtLocation(tree, ["integrations"]) : undefined;
      }

      const count = integrationsNode?.children?.length ?? 0;
      const edits = jsonc.modify(text, ["integrations", count], integration, {
        formattingOptions: FORMATTING,
      });
      text = jsonc.applyEdits(text, edits);
    }

    yield* fs.writeFileString(path, text);
  });

/**
 * Remove an integration from the config file by namespace.
 */
export const removeIntegrationFromConfig = (
  path: string,
  namespace: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const exists = yield* fs.exists(path);
    if (!exists) return;

    let text = yield* fs.readFileString(path);
    const tree = jsonc.parseTree(text);
    if (!tree) return;

    const integrationsNode = jsonc.findNodeAtLocation(tree, ["integrations"]);
    if (!integrationsNode?.children) return;

    // Walk backwards so indices stay valid after each removal
    for (let i = integrationsNode.children.length - 1; i >= 0; i--) {
      const child = integrationsNode.children[i]!;
      const nsNode = jsonc.findNodeAtLocation(child, ["namespace"]);
      if (nsNode && jsonc.getNodeValue(nsNode) === namespace) {
        const edits = jsonc.modify(text, ["integrations", i], undefined, {
          formattingOptions: FORMATTING,
        });
        text = jsonc.applyEdits(text, edits);
      }
    }

    yield* fs.writeFileString(path, text);
  });

/**
 * Write a full config object to a file.
 */
export const writeConfig = (
  path: string,
  config: ExecutorFileConfig,
): Effect.Effect<void, ConfigWriteError | PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* Effect.try({
      try: () => JSON.stringify(config, null, 2) + "\n",
      catch: (cause) => new ConfigWriteError(path, cause),
    });
    yield* fs.writeFileString(path, text);
  });

/**
 * Add secret metadata to the config file.
 */
export const addSecretToConfig = (
  path: string,
  secretId: string,
  metadata: { name: string; provider?: string; purpose?: string },
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let text = yield* readOrCreate(fs, path);

    const edits = jsonc.modify(text, ["secrets", secretId], metadata, {
      formattingOptions: FORMATTING,
    });
    text = jsonc.applyEdits(text, edits);

    yield* fs.writeFileString(path, text);
  });

/**
 * Remove secret metadata from the config file.
 */
export const removeSecretFromConfig = (
  path: string,
  secretId: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const exists = yield* fs.exists(path);
    if (!exists) return;

    let text = yield* fs.readFileString(path);
    const edits = jsonc.modify(text, ["secrets", secretId], undefined, {
      formattingOptions: FORMATTING,
    });
    text = jsonc.applyEdits(text, edits);

    yield* fs.writeFileString(path, text);
  });
