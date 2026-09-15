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
  "Find connected integration tools with search, then call invoke with the returned tool ID and JSON arguments. " +
  "Search returns input schemas and account details. Use its nextOffset to get more matches. " +
  "Invoke can change external state; your client handles approval for each call. Workspace block policies remain enforced. " +
  "No JavaScript, execute, resume, or artifact tools are exposed in this mode.";
