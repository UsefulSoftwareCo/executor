import { Effect } from "effect";
import type { Connection, Integration, Executor } from "@executor-js/sdk/core";

/**
 * Builds a tool description dynamically.
 *
 * Structure:
 *   1. Workflow (top — critical, least likely to be truncated)
 *   2. Available connection prefixes (bottom)
 *
 * v2: callable API tools are scoped by saved connections. A tool's sandbox
 * address is `tools.<integration>.<owner>.<connection>.<tool>`, so the useful
 * inventory is the connection prefix rather than only the integration slug.
 */
export const buildExecuteDescription = (executor: Executor): Effect.Effect<string> =>
  Effect.gen(function* () {
    const connections: readonly Connection[] = yield* executor.connections.list().pipe(
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: ExecutionEngine.getDescription currently exposes no error channel; engine typed-error widening is covered separately
      Effect.orDie,
      Effect.withSpan("executor.connections.list"),
    );
    const integrations: readonly Integration[] = yield* executor.integrations.list().pipe(
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: same getDescription error-channel constraint as connections.list above
      Effect.orDie,
      Effect.withSpan("executor.integrations.list"),
    );

    const description = yield* Effect.sync(() =>
      formatDescription(connections.map((connection) => connectionEntry(connection, integrations))),
    ).pipe(
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

/** One inventory line: the callable prefix plus the best available context.
 *  Connection description wins (the user wrote it about THIS credential);
 *  otherwise the integration description, unless it is just the slug again. */
interface ConnectionInventoryEntry {
  readonly prefix: string;
  readonly description?: string;
}

const inventoryNote = (
  text: string | null | undefined,
  identityEchoes: readonly string[],
): string | undefined => {
  const firstLine = (text ?? "").split("\n", 1)[0]!.trim();
  if (firstLine.length === 0) return undefined;
  // A description that just restates the slug or display name carries no
  // information beyond identity — drop it from the inventory line.
  if (identityEchoes.some((echo) => firstLine.toLowerCase() === echo.toLowerCase())) {
    return undefined;
  }
  return firstLine.length > 140 ? `${firstLine.slice(0, 139)}…` : firstLine;
};

const connectionEntry = (
  connection: Connection,
  integrations: readonly Integration[],
): ConnectionInventoryEntry => {
  const slug = String(connection.integration);
  const integration = integrations.find((candidate) => String(candidate.slug) === slug);
  const identityEchoes = [slug, ...(integration ? [integration.name] : [])];
  return {
    prefix: connectionPath(connection),
    description:
      inventoryNote(connection.description, identityEchoes) ??
      inventoryNote(integration?.description, identityEchoes),
  };
};

const formatDescription = (connectionEntries: readonly ConnectionInventoryEntry[]): string => {
  const lines: string[] = [
    "Execute TypeScript in a sandboxed runtime with access to configured API tools.",
    "",
    "## Workflow",
    "",
    '1. `const { items: matches } = await tools.search({ query: "<intent + key nouns>", limit: 12 });`',
    '2. `const path = matches[0]?.path; if (!path) return "No matching tools found.";`',
    "3. `const details = await tools.describe.tool({ path });`",
    "4. Use `details.inputTypeScript`, `details.outputTypeScript`, and `details.typeScriptDefinitions` for compact shapes.",
    "5. Call the exact discovered path: `const result = await tools[path](input);`",
    "6. Branch on `result.ok`; `emit(...)` user-visible output, or `return` structured data you need to read.",
    "",
    "## Tool Discovery",
    "",
    "- `tools.search()` returns paginated, ranked matches: `{ items, total, hasMore, nextOffset }`. Best-first. Use short intent phrases like `github issues`, `repo details`, or `create calendar event`.",
    '- When you already know the namespace, narrow with `tools.search({ namespace: "github", query: "issues" })`.',
    "- If `tools.search()` returns `hasMore: true` and you didn't find what you need, fetch the next page: `tools.search({ query, offset: nextOffset, limit })`.",
    "- `tools.describe.tool()` returns compact TypeScript shapes. If the path does not resolve, use its `error.suggestions` instead of retrying the same path.",
    "- Always call the full address returned as `path`: `tools.<integration>.<owner>.<connection>.<tool>(args)`. Do not guess path segments.",
    "- The `tools` object is lazy. `Object.keys(tools)` returns bounded built-ins (`search`, `describe`, `executor`), not the full API catalog.",
    "- `tools.executor.coreTools.connections.list({})` returns saved connections with `{ address, integration, owner, name, ... }`. The `address` field includes the leading `tools.` root.",
    '- Pass an object to system tools, e.g. `tools.search({ query: "..." })`, `tools.describe.tool({ path })`, and `tools.executor.coreTools.connections.list({})`.',
    "",
    "## Tool Results",
    "",
    "- Tool calls return a value union: `{ ok: true, data }` for success or `{ ok: false, error: { code, message, status?, details?, retryable? } }` for expected tool/domain failures. Branch on `result.ok`.",
    "- `data` is the upstream payload itself. HTTP-backed tools (OpenAPI) also set `http: { status, headers }` beside `data` — read `result.http?.headers` for pagination (Link) or rate-limit headers.",
    "- For tools that return large collections (e.g. `getStates`, `getAll`), filter results in code rather than calling per-item tools.",
    "- Do not use `fetch` — all API calls go through `tools.*`.",
    "",
    "## Output",
    "",
    "- Use `emit(value)` to append user-visible output. Emitted output goes to the user, not back to you; to read a value yourself, `return` it.",
    "- Prefer explicit output helpers when the content kind is known: `text(value)`, `image(value, detail?)`, `audio(block)`, `file(toolFile)`, `resource(block)`, and `notify(value)`. `image` accepts a base64 data URI string, `{ image_url, detail }`, or a raw MCP image block; `detail` may be `auto`, `low`, `high`, or `original`.",
    '- File-returning tools may return `ToolFile` values: `{ _tag: "ToolFile", name?, mimeType, encoding: "base64", data, byteLength }`. Emit attachments with `emit(result.data)` or `file(result.data)`.',
    '- `emit(...)` also accepts MCP content blocks such as `{ type: "image", data, mimeType }`, `{ type: "text", text }`, `{ type: "resource", resource }`, and `{ type: "resource_link", uri, name, ... }`.',
    "- `emit(ToolFile)` is MIME-based: images, audio, text-like files, and other binary files are rendered as the corresponding MCP content.",
    "- `return` is only for ordinary structured data. Returning a `ToolFile`, `ToolResult`, MCP content block, or bare base64 string does not emit content to the MCP client.",
    "",
    "## Runtime Notes",
    "",
    "- For work that yields progress, runs longer than one request, or needs incremental observation, use the separate `execute_cell` and `wait_cell` tools instead of `execute`.",
    "- If `execute` pauses for user interaction, resume it with the returned `resumePayload`. Do not use `resume` for execution cells.",
    "- TypeScript type syntax (`: T`, `as T`, generics, interfaces, type aliases) is stripped before execution — feel free to write idiomatic TypeScript using the shapes from `tools.describe.tool()`. Decorators and `enum` are not supported.",
  ];

  if (connectionEntries.length > 0) {
    lines.push("");
    lines.push("## Available connection prefixes");
    lines.push("");
    lines.push("These are paths under `tools.`; append the final tool segment.");
    const sorted = [...connectionEntries]
      .sort((a, b) => a.prefix.localeCompare(b.prefix))
      .slice(0, 50);
    for (const entry of sorted) {
      lines.push(
        entry.description
          ? `- \`${entry.prefix}\` — ${entry.description}`
          : `- \`${entry.prefix}\``,
      );
    }
    if (connectionEntries.length > sorted.length) {
      lines.push(`- ... ${connectionEntries.length - sorted.length} more`);
    }
  }

  return lines.join("\n");
};
