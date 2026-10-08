import type { Skill } from "@executor-js/execution";

/**
 * The sandbox code a passthrough call runs. Built HERE from the session's
 * resolved address and a JSON-encoded argument — never concatenated from raw
 * model input — and shaped exactly like the artifact `execute-action` grammar
 * (`return await tools.<path>(<json>)`), so it takes the same engine path as
 * every other execution: billing, rate limits, shape memory and analytics all
 * see it as one execution.
 */
export const passthroughCallCode = (address: string, args: unknown): string => {
  // The whole dotted address is ONE JSON string literal in bracket notation:
  // `tools["github.org.main.items.then"](...)`. Two reasons it is not a chain
  // of property accesses. The tool segment is customer-controlled (an OpenAPI
  // spec may set `x-executor-toolPath`), so it must be data in the generated
  // source, never syntax. And every sandbox proxy reserves the property name
  // `then` (a thenable check would otherwise await the proxy itself), so a
  // per-segment chain could never reach a tool whose path contains `then`.
  // Each proxy joins the accessed keys with `.` to form the dispatch path, so
  // a single key holding the dotted address reassembles to exactly the same
  // path the chain would have.
  const bare = address.startsWith("tools.") ? address.slice("tools.".length) : address;
  return `return await tools[${JSON.stringify(bare)}](${JSON.stringify(args ?? {})});`;
};

/**
 * The server `instructions`: the shortest path from a request to a call,
 * with one worked example. Everything longer lives in the search-invoke
 * guide, which costs context only when a model asks for it.
 */
export const passthroughInstructions = (): string =>
  [
    "Executor runs tools of connected integrations. Fastest path, three calls:",
    "1. integrations({}) once, to learn the integration slugs and accounts (skip when you already know the slug).",
    '2. search({ query: "<action words>", integration: "<slug or alias>", limit: 3 }). Hits are compact: id, one-line description, and an argument summary.',
    "3. invoke({ tool: <hit id>, arguments: { ... } }).",
    'Example: search({ query: "create issue", integration: "github", limit: 3 }) then invoke({ tool: "tools.github.org.main.issues.create", arguments: { title: "Bug" } }).',
    'Use detail: "full" on search only when the argument summary is not enough; an invoke rejected for invalid arguments also returns the schema.',
    'Invoke can change external state; your client handles approval and workspace blocks stay enforced. skills({ name: "search-invoke" }) has the long guide.',
  ].join("\n");

/** On-demand guidance for the JSON tool surface; no sandbox or artifact instructions. */
export const SEARCH_INVOKE_SKILL: Skill = {
  name: "search-invoke",
  summary: "Discover connected accounts, search for actions, and invoke tools with JSON arguments.",
  body: [
    "# Search and invoke",
    "",
    "1. Call `integrations({})` to see connected integrations and accounts. Each item includes an integration description, account label, and last recorded health. A null health verdict means the account has not been checked; a saved connection does not guarantee a working credential.",
    '2. Call `search({ query: "create issue", integration: "github", owner: "org", connection: "main" })`. Use the integration, owner, and connection returned by integrations to select an account. `integration` also accepts an unambiguous alias (`gmail` resolves to `google_gmail`); the result reports the resolved slug as `integration`, lists candidates as `integrations` when the alias is ambiguous, or adds a `hint` when nothing matches. Omit filters to search across accounts visible to you.',
    '3. Read the hit\'s `arguments` summary (`name (type, required); other (type)`). Call `invoke({ tool: <exact returned id>, arguments: <JSON object> })`. Do not guess tool IDs or arguments. When the summary is not enough, repeat the search with `detail: "full"` and `limit: 1` to get the complete `inputSchema`; an invoke rejected for invalid arguments also returns the schema.',
    "",
    "## Pagination",
    "Both integrations and search return `{ items, total, hasMore, nextOffset }`. If hasMore is true, repeat the call with the same filters and `offset: nextOffset`. Search also needs the same query. Search returns at most 20 tools per page; prefer `limit: 3` with an `integration` filter.",
    "Tool-search pagination is separate from an upstream API's pagination. Follow the invoked tool's schema and response for cursor or page arguments when retrieving more records.",
    "",
    "## Results and approval",
    "Invoke forwards the tool's result, including supported MCP content. Check `isError` and any returned error before treating a call as successful. Your client handles approval for invoke; workspace block policies still apply. An upstream request for user input needs a client that supports native elicitation.",
    "If a tool is no longer available, search again. If an account needs authentication, ask the user to reconnect it in Executor. Never ask for credentials in chat.",
    "This mode accepts JSON tool arguments. It does not expose general execute or resume tools. When artifacts are enabled, use create-artifact, edit-artifact, list-artifacts, and show-artifact; read the create-artifact and artifact-style guides through skills first. The skills tool serves only this server's guides, not files or skills from your harness or project.",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Compact search results
// ---------------------------------------------------------------------------

/** Characters kept from a tool description in a compact search hit. */
export const COMPACT_DESCRIPTION_LIMIT = 200;
/** Properties named in a compact argument summary before "+N more". */
export const COMPACT_ARGUMENT_LIMIT = 12;
/** Enum values spelled out in a compact argument summary. */
const COMPACT_ENUM_LIMIT = 6;
/** Keys named for a nested object argument. */
const COMPACT_NESTED_KEY_LIMIT = 6;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The first sentence or line of a description, capped. Search hits are read
 * once to pick a tool; the full text stays behind `detail: "full"`.
 */
export const compactDescription = (description: string | undefined): string => {
  if (description === undefined) return "";
  const firstLine = description.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  const sentence = collapsed.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? collapsed;
  // A very short first "sentence" ("No." / "v2.") is usually not one.
  const kept = sentence.length >= 12 || sentence.length === collapsed.length ? sentence : collapsed;
  return kept.length <= COMPACT_DESCRIPTION_LIMIT
    ? kept
    : `${kept.slice(0, COMPACT_DESCRIPTION_LIMIT - 1).trimEnd()}…`;
};

const resolveRef = (
  node: Record<string, unknown>,
  defs: ReadonlyMap<string, unknown>,
): Record<string, unknown> => {
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  const name = ref.replace(/^#\/(\$defs|definitions)\//, "");
  const target = defs.get(name);
  return isRecord(target) ? target : node;
};

/** A short type label for one JSON Schema node: `string`, `A|AAAA`, `string[]`, `object`. */
const typeLabel = (value: unknown, defs: ReadonlyMap<string, unknown>, depth = 0): string => {
  if (!isRecord(value)) return "any";
  const node = resolveRef(value, defs);
  if (Array.isArray(node.enum)) {
    const values = node.enum.map((item) => String(item));
    return values.length <= COMPACT_ENUM_LIMIT
      ? values.join("|")
      : `${values.slice(0, COMPACT_ENUM_LIMIT).join("|")}|…`;
  }
  if (node.const !== undefined) return JSON.stringify(node.const);
  const variants = [node.oneOf, node.anyOf].find(Array.isArray);
  if (variants && depth < 1) {
    const labels = [
      ...new Set(variants.map((variant: unknown) => typeLabel(variant, defs, depth + 1))),
    ];
    return labels.length <= 3 ? labels.join("|") : "any";
  }
  const type = Array.isArray(node.type)
    ? node.type.filter((item) => item !== "null").join("|")
    : typeof node.type === "string"
      ? node.type
      : undefined;
  if (type === "array") {
    const items = depth < 1 ? typeLabel(node.items, defs, depth + 1) : "any";
    return items.includes("|") ? `(${items})[]` : `${items}[]`;
  }
  if (type === "object" || (type === undefined && isRecord(node.properties)))
    return objectLabel(node, depth);
  return type ?? "any";
};

/**
 * `object{text*, title}`: the first-level keys of a nested object, required
 * ones starred. OpenAPI tools wrap their inputs (`body`, `query`, `path`), so
 * without this a summary would say only `body (object, required)`.
 */
const objectLabel = (node: Record<string, unknown>, depth: number): string => {
  if (depth >= 1 || !isRecord(node.properties)) return "object";
  const required = new Set(Array.isArray(node.required) ? node.required.map(String) : []);
  const names = Object.keys(node.properties);
  if (names.length === 0) return "object";
  const shown = names
    .slice(0, COMPACT_NESTED_KEY_LIMIT)
    .map((name) => (required.has(name) ? `${name}*` : name));
  const rest = names.length - shown.length;
  return `object{${shown.join(", ")}${rest > 0 ? `, +${rest}` : ""}}`;
};

/**
 * One line naming a tool's arguments: `name (type, required); other (type)`.
 * Enough to call most tools without the full schema; `detail: "full"` has the
 * rest. Schemas that are not a plain object come back as `see full schema`.
 */
export const compactArguments = (
  inputSchema: unknown,
  definitions?: Record<string, unknown>,
): string => {
  if (!isRecord(inputSchema)) return "none";
  // Definitions may ride inside the schema (`$defs`) or beside it (the view's
  // `schemaDefinitions`); both resolve the same `#/$defs/<name>` pointers.
  const defs = new Map<string, unknown>([
    ...Object.entries(definitions ?? {}),
    ...Object.entries(isRecord(inputSchema.definitions) ? inputSchema.definitions : {}),
    ...Object.entries(isRecord(inputSchema.$defs) ? inputSchema.$defs : {}),
  ]);
  const schema = resolveRef(inputSchema, defs);
  const properties = schema.properties;
  if (!isRecord(properties)) {
    if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.allOf))
      return "see full schema";
    return "none";
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const names = Object.keys(properties);
  if (names.length === 0) return "none";
  const ordered = [
    ...names.filter((name) => required.has(name)),
    ...names.filter((name) => !required.has(name)),
  ];
  const shown = ordered.slice(0, COMPACT_ARGUMENT_LIMIT).map((name) => {
    const label = typeLabel(properties[name], defs);
    return required.has(name) ? `${name} (${label}, required)` : `${name} (${label})`;
  });
  const rest = ordered.length - shown.length;
  return rest > 0 ? `${shown.join("; ")}; +${rest} more` : shown.join("; ");
};

// ---------------------------------------------------------------------------
// Integration aliases live in @executor-js/execution so the sandbox
// `tools.search({ namespace })` resolves them the same way; re-exported here
// so the host surface is unchanged.
// ---------------------------------------------------------------------------

export {
  integrationAliasText,
  resolveIntegrationAlias,
  type IntegrationCatalogEntry,
  type IntegrationResolution,
} from "@executor-js/execution";
