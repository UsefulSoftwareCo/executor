import { Effect } from "effect";
import type { Connection, Executor } from "@executor-js/sdk/core";

/**
 * Builds the `execute` tool description dynamically.
 *
 * Structure:
 *   1. One-line intro + pointer to the `execute` skill (the full how-to lives
 *      behind the `skills` tool, see ./skills.ts, to keep this always-loaded
 *      description small)
 *   2. Available integrations (the live, per-session inventory): the top-level
 *      integration slugs the user has connected, deduped across connections,
 *      names only. The same block is appended to the `execute` skill content.
 */

/** The header that opens the live integration inventory. Exported so the host
 *  can locate (and re-use) the inventory block inside the built description. */
export const INTEGRATION_INVENTORY_HEADER = "## Available integrations";

export const buildExecuteDescription = (executor: Executor): Effect.Effect<string> =>
  Effect.gen(function* () {
    const connections: readonly Connection[] = yield* executor.connections.list().pipe(
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: ExecutionEngine.getDescription currently exposes no error channel; engine typed-error widening is covered separately
      Effect.orDie,
      Effect.withSpan("executor.connections.list"),
    );

    const description = yield* Effect.sync(() => {
      const lines = [
        "Execute TypeScript in a sandboxed runtime.",
        "",
        'Before writing code, call `skills({ name: "execute" })` for the workflow on how to use this tool.',
      ];
      const inventory = formatIntegrationInventory(connections);
      if (inventory.length > 0) {
        lines.push("");
        lines.push(inventory);
      }
      return lines.join("\n");
    }).pipe(
      Effect.withSpan("schema.compile.description", {
        attributes: { "executor.connection_count": connections.length },
      }),
    );

    yield* Effect.annotateCurrentSpan({
      "executor.connection_count": connections.length,
      "schema.kind": "execute",
      // Connection inventory so a failing session build (which runs this during
      // init) names the callable prefixes it resolved without listing tools.
      "executor.connection_addresses": connections
        .map((connection) => connectionPath(connection))
        .slice(0, 50)
        .join(","),
      "executor.connection_integrations": [
        ...new Set(connections.map((connection) => String(connection.integration))),
      ].join(","),
      "executor.connection_owners": [
        ...new Set(connections.map((connection) => connection.owner)),
      ].join(","),
    });

    return description;
  }).pipe(Effect.withSpan("schema.describe.execute"));

const connectionPath = (connection: Connection): string => {
  const address = String(connection.address);
  return address.startsWith("tools.") ? address.slice("tools.".length) : address;
};

// The live inventory block: the top-level integrations the user has connected,
// one bare line per integration slug (deduped across connections, sorted), no
// per-connection prefixes and no descriptions. Empty string when nothing is
// connected.
const INVENTORY_LIMIT = 50;

const formatIntegrationInventory = (connections: readonly Connection[]): string => {
  const slugs = [...new Set(connections.map((connection) => String(connection.integration)))].sort(
    (a, b) => a.localeCompare(b),
  );
  if (slugs.length === 0) return "";
  const shown = slugs.slice(0, INVENTORY_LIMIT);
  const lines = [
    INTEGRATION_INVENTORY_HEADER,
    "",
    "Integrations you have connected. Their tools live under `tools.<integration>.…`.",
    ...shown.map((slug) => `- \`${slug}\``),
  ];
  if (slugs.length > shown.length) {
    lines.push(`- ... ${slugs.length - shown.length} more`);
  }
  return lines.join("\n");
};
