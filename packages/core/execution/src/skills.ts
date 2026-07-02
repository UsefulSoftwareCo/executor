/**
 * On-demand documentation served through the MCP `skills` tool.
 *
 * The long-form how-to for calling integrations used to live in the `execute`
 * tool description, which every session loads into its prompt up front. That
 * is pure context bloat: a model that never calls `execute` still pays for the
 * whole calling-convention essay. Moving it behind a tool lets the `execute`
 * description carry only the live connection inventory plus a pointer here, and
 * the model fetches the full guide the moment it actually needs it.
 *
 * A skill is a static, named markdown document. The registry is intentionally
 * tiny and hand-curated, not a plugin surface: add an entry only when a tool
 * genuinely needs its own how-to behind the same `skills` door.
 */

export interface Skill {
  /** Stable identifier the model passes to the `skills` tool. */
  readonly name: string;
  /** One-line summary, shown when the `skills` tool lists what is available. */
  readonly summary: string;
  /** The full markdown body returned when the skill is fetched by name. */
  readonly body: string;
}

// The `execute` how-to. This is the body lifted verbatim out of the old
// `buildExecuteDescription` (Workflow + Rules); the description now points
// here instead of inlining it.
const EXECUTE_SKILL_BODY = [
  "# execute",
  "",
  "Execute TypeScript in a sandboxed runtime with access to configured API tools.",
  "",
  "## Workflow",
  "",
  '1. `const { items: matches } = await tools.search({ query: "<intent + key nouns>", limit: 12 });`',
  '2. `const path = matches[0]?.path; if (!path) return "No matching tools found.";`',
  "3. `const details = await tools.describe.tool({ path });`",
  "4. Use `details.inputTypeScript` / `details.outputTypeScript` and `details.typeScriptDefinitions` for compact shapes.",
  "5. Use `tools.executor.coreTools.connections.list({})` when you need live saved-connection inventory.",
  "6. Call the tool: `const result = await tools.<path>(input);`",
  "",
  "## Rules",
  "",
  "- `tools.search()` returns paginated, ranked matches: `{ items, total, hasMore, nextOffset }`. Best-first. Use short intent phrases like `github issues`, `repo details`, or `create calendar event`.",
  '- When you already know the namespace, narrow with `tools.search({ namespace: "github", query: "issues" })`.',
  "- `tools.executor.coreTools.connections.list({})` returns saved connections with `{ address, integration, owner, name, ... }`. The `address` field includes the leading `tools.` root.",
  "- Tool calls return a value union: `{ ok: true, data }` for success or `{ ok: false, error: { code, message, status?, details?, retryable? } }` for expected tool/domain failures. Branch on `result.ok`.",
  "- `data` is the upstream payload itself. HTTP-backed tools (OpenAPI) also set `http: { status, headers }` beside `data` — read `result.http?.headers` for pagination (Link) or rate-limit headers.",
  "- Use `emit(value)` to append user-visible output and return `undefined`. Plain values become MCP text content. MCP content blocks are forwarded as-is. `ToolFile` values are rendered by MIME. Emitted output goes to the user, not back to you; the result envelope reports an `emitted` count so you can confirm it landed, but to read a value yourself, `return` it.",
  '- File-returning tools may return `ToolFile` values: `{ _tag: "ToolFile", name?, mimeType, encoding: "base64", data, byteLength }`. Emit any attachment with `emit(result.data)`.',
  '- To emit MCP-native content directly, pass an MCP content block to `emit(...)`, such as `{ type: "image", data, mimeType }`, `{ type: "audio", data, mimeType }`, `{ type: "text", text }`, `{ type: "resource", resource }`, or `{ type: "resource_link", uri, name, ... }`.',
  "- `emit(ToolFile)` is MIME-based: `image/*` becomes MCP image content, `audio/*` becomes MCP audio content, text-like files become decoded text, and other binary files become embedded MCP resources.",
  "- `return` is only for ordinary structured data. Returning a `ToolFile`, a `ToolResult`, an MCP content block, or a bare base64 string does not emit content to the MCP client.",
  "- Some providers, including Gmail, return attachment bytes without a public URL. To send that attachment to another API from code, decode `ToolFile.data` from base64 and pass the bytes to that API's upload/file input.",
  "- If `tools.search()` returns `hasMore: true` and you didn't find what you need, fetch the next page: `tools.search({ query, offset: nextOffset, limit })`.",
  "- Always use the full address when calling tools: `tools.<integration>.<owner>.<connection>.<tool>(args)`. The `path` returned by `tools.search()` / `tools.describe.tool()` is already the exact path under `tools` — call `tools[path]` rather than guessing segments.",
  "- The `tools` object is a lazy proxy — `Object.keys(tools)` won't work. Use `tools.search()` or `tools.executor.coreTools.connections.list({})` instead.",
  '- Pass an object to system tools, e.g. `tools.search({ query: "..." })`, `tools.executor.coreTools.connections.list({})`, and `tools.describe.tool({ path })`.',
  '- `tools.describe.tool()` returns compact TypeScript shapes. Use `inputTypeScript`, `outputTypeScript`, and `typeScriptDefinitions`. If the path doesn\'t resolve, the result carries `error: { code: "tool_not_found", suggestions }` — use a suggestion instead of retrying the same path.',
  "- For tools that return large collections (e.g. `getStates`, `getAll`), filter results in code rather than calling per-item tools.",
  "- Do not use `fetch` — all API calls go through `tools.*`.",
  "- If execution pauses for interaction, resume it with the returned `resumePayload`.",
  "- TypeScript type syntax (`: T`, `as T`, generics, interfaces, type aliases) is stripped before execution — feel free to write idiomatic TypeScript using the shapes from `tools.describe.tool()`. Decorators and `enum` are not supported.",
].join("\n");

export const EXECUTE_SKILL: Skill = {
  name: "execute",
  summary:
    "How to call integrations from the execute sandbox: search the catalog, read a tool's shape, call it, emit results, and resume paused runs.",
  body: EXECUTE_SKILL_BODY,
};

/** The full skill catalog. Hand-curated; keep it small. */
export const SKILLS: readonly Skill[] = [EXECUTE_SKILL];

/** Look up a skill by its exact name. */
export const findSkill = (name: string): Skill | undefined =>
  SKILLS.find((skill) => skill.name === name);

/** The index the `skills` tool returns when called without a name (or with an
 *  unknown one): every skill's name and one-line summary, plus how to fetch
 *  the body. */
export const renderSkillsIndex = (): string =>
  [
    'Available skills. Fetch one with `skills({ name: "<name>" })`.',
    "",
    ...SKILLS.map((skill) => `- \`${skill.name}\` — ${skill.summary}`),
  ].join("\n");
