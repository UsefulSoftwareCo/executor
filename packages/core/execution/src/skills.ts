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
  "- The `tools` object is a lazy proxy — enumerating it (`Object.keys(tools)`, spread, `for...in`) throws. Use `tools.search()` or `tools.executor.coreTools.connections.list({})` instead.",
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

// The `create-artifact` how-to. Same reasoning as `execute`: the discovery-vs-render
// protocol, the TanStack rules and the component inventory are a page of prose
// that only matters once a model decides to build a UI, so the tool description
// stays short and points here.
const SHADCN_COMPONENTS =
  "Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Button, Input, Textarea, Label, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Checkbox, Switch, Slider, Toggle, Tabs, TabsList, TabsTrigger, TabsContent, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Badge, Avatar, AvatarFallback, Alert, AlertTitle, AlertDescription, Dialog, Sheet, Popover, Tooltip, Separator, ScrollArea, Skeleton, Progress, Accordion, AccordionItem, AccordionTrigger, AccordionContent, DropdownMenu + sub-components";

const RECHARTS_COMPONENTS =
  "BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Legend, ChartContainer, ChartTooltip, ChartTooltipContent";

const LUCIDE_ICONS =
  "Plus, Minus, Check, X, Search, Loader2, AlertCircle, ExternalLink, Copy, Trash2, Edit, Settings, User, Globe, Star, TrendingUp, Activity, Database, Shield, Package, and more";

const CREATE_ARTIFACT_SKILL_BODY = [
  "# create-artifact",
  "",
  "Render an interactive React UI component as an MCP app, and save it as an artifact.",
  "",
  "Every successful render is persisted under the `title` you supply, so the user can",
  "reopen it later and you can find it again with `list-artifacts` / `show-artifact`.",
  "Give it a short human-readable name (`Active users dashboard`), and a `description`",
  "describing what it shows — that description is what a later request like",
  '"show me my active users dashboard" is matched against.',
  "",
  "## Workflow",
  "",
  "1. If you need to understand tool names, query syntax, required arguments, response shapes, IDs, mutation inputs, or a list tool's cursor field, first use the regular `execute` tool to inspect them.",
  "2. Then call `create-artifact` with a component named `App` in the `code` parameter.",
  "3. Recreate every read from the discovery step inside `App` with `useQuery(tools.<namespace>.<tool>.queryOptions(args))` so the UI stays live.",
  "4. Use `useMutation(tools.<namespace>.<tool>.mutationOptions({ onSuccess }))` for user-triggered writes or actions.",
  "5. Return only the component code.",
  "",
  "## The Contract: tools.* Only",
  "",
  "Artifact code is purely declarative. Every read and every write goes through the",
  "`tools` proxy's TanStack helpers — there is no way to run arbitrary code from an",
  "artifact, and no `run(...)` function. Two rules follow, and both are enforced:",
  "",
  "- **Never hand-roll `useQuery({ queryKey, queryFn })`.** Always pass the proxy's options object: `useQuery(tools.<ns>.<tool>.queryOptions(args))`. A hand-written `queryKey` is invisible to `queryFilter`/`pathFilter`, so mutations silently stop refreshing the UI, and it hides which tool the artifact uses from artifact analysis.",
  "- **Never fetch in a loop by hand.** Cursor pagination is declarative — see below.",
  "",
  "## Using Execute For Discovery",
  "",
  "- `execute` is for exploration: list datasets, inspect schemas, test a query, fetch one small sample row, or learn the exact mutation input shape.",
  "- `create-artifact` is for the final interactive surface. Do not paste discovery results into JSX as literal rows, cards, summaries, metrics, or chart series.",
  "- After discovering an API call with `execute`, put the same call in TanStack Query options inside the generated component.",
  "- Example discovery: call `execute` with `return await tools.axiom_mcp.querydataset({ ... })` to confirm columns, then call `create-artifact` with `useQuery(tools.axiom_mcp.querydataset.queryOptions({ ... }))`.",
  "- Use discovered result shapes exactly. If a sample or schema returns `{ renew, expiresAt }`, read `data?.renew`, not `data?.domain?.renew`.",
  "- Keep discovery small. Use limits, narrow time ranges, or schema/list tools when possible.",
  "",
  "## TanStack Query State",
  "",
  "- The component is already wrapped in a `QueryClientProvider`; do not create your own.",
  "- Use `const queryClient = useQueryClient()` when a mutation changes data shown by a query.",
  "- For simple writes, invalidate with `queryClient.invalidateQueries(tools.<namespace>.<queryTool>.queryFilter(args))` in `onSuccess` or `onSettled`.",
  "- For toggles and switches, pass the new checked value into `mutate`: `onCheckedChange={(checked) => mutation.mutate({ body: { enabled: checked } })}`.",
  "- For optimistic UI, use `onMutate` to `cancelQueries`, snapshot `getQueryData`, and `setQueryData`; return the snapshot, restore it in `onError`, and invalidate in `onSettled`.",
  "- Tool proxy helpers are TanStack-native: `.queryOptions(args, options)`, `.infiniteQueryOptions(args, options)`, `.mutationOptions(options)`, `.queryKey(args)`, `.queryFilter(args, filters)`, `.infiniteQueryKey(args)`, `.infiniteQueryFilter(args, filters)`, `.pathKey()`, `.pathFilter(filters)`, and `.mutationKey()`.",
  "- `.pathFilter()` matches BOTH a tool's plain and infinite queries, so one `queryClient.invalidateQueries(tools.<ns>.<tool>.pathFilter())` after a mutation refreshes every view of that tool.",
  "",
  "## Paginated Reads",
  "",
  "When a tool returns one page plus a cursor, use `useInfiniteQuery` with",
  "`.infiniteQueryOptions(args, options)`. You supply TanStack's standard",
  "`initialPageParam` and `getNextPageParam`; the proxy merges each page param",
  "into the tool input for you and mints the query key.",
  "",
  "- `getNextPageParam(lastPage, allPages)` reads the cursor out of the tool's own response. Return `undefined` (or `null`) when there are no more pages — that is what stops the paging.",
  "- `initialPageParam` defaults to `null`, which means the FIRST request carries no cursor at all. Set it only when a tool requires an explicit starting value (e.g. `initialPageParam: 1` for page numbers).",
  '- `cursorKey` says where the page param lands in the tool input. It defaults to `"cursor"`. Use a dotted path for nested inputs — `cursorKey: "query.since"` writes `{ query: { since: <pageParam> } }`. Read the tool\'s input shape with `execute` first; do not guess the field name.',
  "- Render `data.pages` (an array of tool results, newest page last) and drive further loading from `hasNextPage` / `fetchNextPage` / `isFetchingNextPage`. Do not call `fetchNextPage` in a loop on mount — let the user pull more, or paginate deliberately with a bounded `useEffect`.",
  "",
  "**Never chain `useQuery` calls in a loop to page through a cursor.** This is",
  "the most common way to get it wrong, and the server rejects it:",
  "",
  "```jsx",
  "// DON'T — a hook per page. The hook count changes between renders (a",
  "// rules-of-hooks violation), and MAX_PAGES silently truncates the data.",
  "function App() {",
  "  const pages = [];",
  "  let cursor = null;",
  "  for (let i = 0; i < MAX_PAGES; i++) {",
  "    const page = useQuery(",
  "      tools.vercel.org.main.getDomains.queryOptions({ limit: 100, since: cursor }),",
  "      { enabled: i === 0 || cursor != null },",
  "    );",
  "    cursor = page.data?.data?.pagination?.next ?? null;",
  "    pages.push(page);",
  "  }",
  "  // …",
  "}",
  "```",
  "",
  "One `useInfiniteQuery` replaces the whole loop — a single hook, paging until",
  "`getNextPageParam` returns `undefined`, with one query key that invalidation",
  "can match. The same domain list, done right (the tool takes `{ limit, since }`",
  "and returns `{ domains, pagination: { next } }`):",
  "",
  "```jsx",
  "function App() {",
  "  const domains = useInfiniteQuery(",
  "    tools.vercel.org.main.getDomains.infiniteQueryOptions(",
  "      { limit: 100 },",
  "      {",
  '        cursorKey: "since",',
  "        getNextPageParam: (lastPage) => lastPage?.data?.pagination?.next ?? undefined,",
  "      },",
  "    ),",
  "  );",
  "",
  '  if (domains.isLoading) return <Skeleton className="h-24 w-full" />;',
  '  if (domains.error) return <Alert variant="destructive"><AlertDescription>{domains.error.message}</AlertDescription></Alert>;',
  "",
  "  const rows = (domains.data?.pages ?? []).flatMap((page) => page?.data?.domains ?? []);",
  "",
  "  return (",
  "    <Card>",
  "      <CardHeader><CardTitle>Domains ({rows.length})</CardTitle></CardHeader>",
  "      <CardContent>",
  "        <Table>",
  "          <TableBody>",
  "            {rows.map((domain) => (",
  "              <TableRow key={domain.id}><TableCell>{domain.name}</TableCell></TableRow>",
  "            ))}",
  "          </TableBody>",
  "        </Table>",
  "        {domains.hasNextPage && (",
  "          <Button onClick={() => domains.fetchNextPage()} disabled={domains.isFetchingNextPage}>",
  '            {domains.isFetchingNextPage ? "Loading…" : "Load more"}',
  "          </Button>",
  "        )}",
  "      </CardContent>",
  "    </Card>",
  "  );",
  "}",
  "```",
  "",
  "## What Is Already In Scope",
  "",
  "**Write no imports.** Everything below is bound before your code runs:",
  "",
  "- React: `useState`, `useEffect`, `useRef`, `useCallback`, `useMemo`, `useContext`, `createContext`, `Fragment`.",
  "- TanStack Query v5: `useQuery`, `useInfiniteQuery`, `useMutation`, `useQueryClient`, `queryOptions`, `infiniteQueryOptions`, `mutationOptions`, `skipToken`.",
  "- The tool proxy `tools`. It is the only way to reach an integration; there is no `run()` and no other escape hatch.",
  `- shadcn/ui components available by name: ${SHADCN_COMPONENTS}`,
  `- Recharts components available by name: ${RECHARTS_COMPONENTS}`,
  `- Lucide icons available by name: ${LUCIDE_ICONS}`,
  "- The class-name helper `cn`.",
  "",
  "## Rules",
  "",
  "- Use this tool instead of `execute` whenever the output should be an interactive UI.",
  "- Export a component named `App`. A top-level `const config = { maxHeight }` sets the frame height.",
  "- Do not call API tools first and paste returned data into JSX.",
  "- Do not embed tool response rows, API results, summaries, dashboard data, or copied query output as literals. Fetch them with `useQuery` so the UI stays live; only hardcode display constants like labels, colors, tab names, and chart configuration.",
  "- Always render the loading and error states from `useQuery` / `useInfiniteQuery` / `useMutation`; do not replace them with hardcoded fallback data.",
  "- Never write `useQuery({ queryKey: [...], queryFn: ... })` by hand. Only `tools.<ns>.<tool>.queryOptions(...)` / `.infiniteQueryOptions(...)` produce keys the invalidation helpers can match.",
  "- Never call a hook inside a `for` / `while` / `do` body. Hooks run unconditionally at the top level of the component, in the same order every render — a loop makes the hook count vary and React breaks. The server rejects it.",
  "- Do not redeclare or destructure provided globals. `const { useState } = React` and `const Card = ...` are rejected by the server before the UI reaches the iframe — use them directly.",
  "- `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and workers are blocked inside the frame. Every read and write goes through `tools`.",
  "- Give `title` a short human-readable name and `description` enough detail that you can find the artifact again later.",
  "",
  "## Retrieving Saved Artifacts",
  "",
  "- `list-artifacts` returns every saved artifact's id, title, description and last-updated time.",
  "- `show-artifact({ id })` re-renders one. Match the user's phrasing against the titles and descriptions from `list-artifacts` rather than guessing an id.",
  "- Clients that cannot display MCP apps get a link to the artifact in the web app instead; pass that URL on to the user verbatim.",
].join("\n");

export const CREATE_ARTIFACT_SKILL: Skill = {
  name: "create-artifact",
  summary:
    "How to write a React component for the create-artifact tool: discover data with execute, keep it live with TanStack Query (including cursor pagination), and what is already in scope.",
  body: CREATE_ARTIFACT_SKILL_BODY,
};

/** The full skill catalog. Hand-curated; keep it small. */
export const SKILLS: readonly Skill[] = [EXECUTE_SKILL, CREATE_ARTIFACT_SKILL];

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
