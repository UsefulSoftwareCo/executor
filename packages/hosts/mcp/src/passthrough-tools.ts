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

/** Describe the fixed search/invoke surface without listing the underlying catalog. */
export const passthroughInstructions = (): string =>
  'Use integrations to see connected accounts and skills({ name: "search-invoke" }) for the workflow. ' +
  "Find connected integration tools with search, then call invoke with the returned tool ID and JSON arguments. " +
  "Search returns input schemas and account details. Use its nextOffset to get more matches. " +
  "Invoke can change external state; your client handles approval for each call. Workspace block policies remain enforced. " +
  "No general execute or resume tools are exposed. When artifacts are enabled, use skills to read their guides.";

/** On-demand guidance for the JSON tool surface; no sandbox or artifact instructions. */
export const SEARCH_INVOKE_SKILL: Skill = {
  name: "search-invoke",
  summary: "Discover connected accounts, search for actions, and invoke tools with JSON arguments.",
  body: [
    "# Search and invoke",
    "",
    "1. Call `integrations({})` to see connected integrations and accounts. Each item includes an integration description, account label, and last recorded health. A null health verdict means the account has not been checked; a saved connection does not guarantee a working credential.",
    '2. Call `search({ query: "create issue", integration: "github", owner: "org", connection: "main" })`. Use the exact integration, owner, and connection returned by integrations to select an account. Omit filters to search across accounts visible to you.',
    "3. Read the matching tool's `inputSchema`. Call `invoke({ tool: <exact returned id>, arguments: <JSON object matching inputSchema> })`. Do not guess tool IDs or arguments.",
    "",
    "## Pagination",
    "Both integrations and search return `{ items, total, hasMore, nextOffset }`. If hasMore is true, repeat the call with the same filters and `offset: nextOffset`. Search also needs the same query. Search returns at most 20 tools per page, with schemas only for those matches.",
    "Tool-search pagination is separate from an upstream API's pagination. Follow the invoked tool's schema and response for cursor or page arguments when retrieving more records.",
    "",
    "## Results and approval",
    "Invoke forwards the tool's result, including supported MCP content. Check `isError` and any returned error before treating a call as successful. Your client handles approval for invoke; workspace block policies still apply. An upstream request for user input needs a client that supports native elicitation.",
    "If a tool is no longer available, search again. If an account needs authentication, ask the user to reconnect it in Executor. Never ask for credentials in chat.",
    "This mode accepts JSON tool arguments. It does not expose general execute or resume tools. When artifacts are enabled, use create-artifact, edit-artifact, list-artifacts, and show-artifact; read the create-artifact and artifact-style guides through skills first. The skills tool serves only this server's guides, not files or skills from your harness or project.",
  ].join("\n"),
};
