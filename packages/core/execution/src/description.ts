import { Effect } from "effect";
import type { Connection, Executor, Integration } from "@executor-js/sdk/core";

/**
 * Builds the `execute` tool description dynamically.
 *
 * Structure:
 *   1. One-line intro + pointer to the `execute` skill (the full how-to lives
 *      behind the `skills` tool, see ./skills.ts, to keep this always-loaded
 *      description small)
 *   2. Available integrations (the live, per-session inventory): the top-level
 *      integration slugs the user has connected, deduped across connections,
 *      each with its one-line capability description from the integration
 *      catalog (user-editable via the integrations API). The same block is
 *      appended to the `execute` skill content.
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

    const integrations: readonly Integration[] = yield* executor.integrations.list().pipe(
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: same as the connections read above; ExecutionEngine.getDescription exposes no error channel
      Effect.orDie,
      Effect.withSpan("executor.integrations.list"),
    );

    const description = yield* Effect.sync(() => {
      const lines = [
        "Execute TypeScript in a sandboxed runtime.",
        "",
        'Before writing code, call `skills({ name: "execute" })` for the workflow on how to use this tool.',
      ];
      const inventory = formatIntegrationInventory(connections, integrations);
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
// one line per integration slug (deduped across connections, sorted) with its
// capability description when the catalog carries one. No per-connection
// prefixes. Empty string when nothing is connected.
const INVENTORY_LIMIT = 50;

/** Longest rendered capability description. The block is always-loaded prompt
 *  context, so one scannable line per integration is the budget. */
const INVENTORY_DESCRIPTION_LIMIT = 120;

/** One inventory line per integration: `` - `slug` `` or
 *  `` - `slug` — description ``. Owned here beside the formatter below so
 *  {@link parseIntegrationInventory} cannot drift from it. */
const INVENTORY_ITEM_PATTERN = /^- `([^`]+)`(?: — .*)?$/;

/**
 * Recover the integration slugs from a built execute description — the exact
 * list `formatIntegrationInventory` rendered, overflow marker excluded. Lets a
 * host derive per-integration surfaces (the opt-in `search_<integration>` MCP
 * tools) from the description it already holds, without a second
 * `connections.list()` that could disagree with what the model reads.
 */
export const parseIntegrationInventory = (description: string): readonly string[] => {
  const index = description.indexOf(INTEGRATION_INVENTORY_HEADER);
  if (index === -1) return [];
  const slugs: string[] = [];
  for (const line of description.slice(index).split("\n")) {
    const match = INVENTORY_ITEM_PATTERN.exec(line);
    if (match?.[1]) slugs.push(match[1]);
  }
  return slugs;
};

/** One scannable line: first line of the catalog description, whitespace
 *  collapsed, capped at {@link INVENTORY_DESCRIPTION_LIMIT} on a word edge. */
const formatInventoryDescription = (description: string | null | undefined): string => {
  if (!description) return "";
  const flat = description.split("\n", 1)[0]!.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  if (flat.length <= INVENTORY_DESCRIPTION_LIMIT) return flat;
  const cut = flat.slice(0, INVENTORY_DESCRIPTION_LIMIT);
  const edge = cut.lastIndexOf(" ");
  return `${edge > 0 ? cut.slice(0, edge) : cut}…`;
};

const formatIntegrationInventory = (
  connections: readonly Connection[],
  integrations: readonly Integration[],
): string => {
  const slugs = [...new Set(connections.map((connection) => String(connection.integration)))].sort(
    (a, b) => a.localeCompare(b),
  );
  if (slugs.length === 0) return "";
  const descriptions = new Map(
    integrations.map((integration) => [
      String(integration.slug),
      {
        name: integration.name,
        summary: formatInventoryDescription(integration.description),
      },
    ]),
  );
  const shown = slugs.slice(0, INVENTORY_LIMIT);
  const lines = [
    INTEGRATION_INVENTORY_HEADER,
    "",
    "Integrations you have connected. Their tools live under `tools.<integration>.…`.",
    ...shown.map((slug) => {
      const entry = descriptions.get(slug);
      // Legacy rows store the slug or display name as the description; a
      // suffix that only repeats the line's own slug adds nothing.
      const summary =
        entry &&
        entry.summary.length > 0 &&
        entry.summary.toLowerCase() !== slug.toLowerCase() &&
        entry.summary.toLowerCase() !== entry.name.toLowerCase()
          ? entry.summary
          : "";
      return summary ? `- \`${slug}\` — ${summary}` : `- \`${slug}\``;
    }),
  ];
  if (slugs.length > shown.length) {
    lines.push(`- ... ${slugs.length - shown.length} more`);
  }
  return lines.join("\n");
};
