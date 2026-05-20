import { Effect } from "effect";
import type { Executor, Source } from "@executor-js/sdk/core";

/**
 * Builds a tool description dynamically.
 *
 * Structure:
 *   1. Workflow (top — critical, least likely to be truncated)
 *   2. Available namespaces (bottom)
 */
export const buildExecuteDescription = (executor: Executor): Effect.Effect<string> =>
  Effect.gen(function* () {
    const sources: readonly Source[] = yield* executor.sources.list().pipe(
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: ExecutionEngine.getDescription currently exposes no error channel; engine typed-error widening is covered separately
      Effect.orDie,
      Effect.withSpan("executor.sources.list"),
    );

    const description = yield* Effect.sync(() => formatDescription(sources)).pipe(
      Effect.withSpan("schema.compile.description", {
        attributes: { "executor.source_count": sources.length },
      }),
    );

    yield* Effect.annotateCurrentSpan({
      "executor.source_count": sources.length,
      "schema.kind": "execute",
    });

    return description;
  }).pipe(Effect.withSpan("schema.describe.execute"));

const formatDescription = (sources: readonly Source[]): string => {
  const lines: string[] = [
    "Execute TypeScript in a sandboxed runtime with access to configured API tools.",
    "",
    "## Workflow",
    "",
    '1. `const { items: matches } = await tools.search({ query: "<intent + key nouns>", limit: 12 });`',
    '2. `const path = matches[0]?.path; if (!path) return "No matching tools found.";`',
    "3. `const details = await tools.describe.tool({ path });`",
    "4. Use `details.inputTypeScript` / `details.outputTypeScript` and `details.typeScriptDefinitions` for compact shapes.",
    "5. Use `tools.executor.sources.list()` when you need configured source inventory.",
    "6. Call the tool: `const result = await tools.<path>(input);`",
    "",
    "## Rules",
    "",
    "- `tools.search()` returns paginated, ranked matches: `{ items, total, hasMore, nextOffset }`. Best-first. Use short intent phrases like `github issues`, `repo details`, or `create calendar event`.",
    '- When you already know the namespace, narrow with `tools.search({ namespace: "github", query: "issues" })`.',
    "- `tools.executor.sources.list()` returns the same paged shape: `{ items: [{ id, toolCount, ... }], total, hasMore, nextOffset }`.",
    "- Tool calls return a value union: `{ ok: true, data }` for success or `{ ok: false, error: { code, message, status?, details?, retryable? } }` for expected tool/domain failures. Branch on `result.ok`.",
    "- If `hasMore` is true and you didn't find what you need, fetch the next page: `tools.search({ query, offset: nextOffset, limit })`. Same `offset` parameter on `tools.executor.sources.list({ offset, limit })`.",
    "- Always use the namespace prefix when calling tools: `tools.<namespace>.<tool>(args)`. Example: `tools.home_assistant_rest_api.states.getState(...)` — not `tools.states.getState(...)`.",
    "- The `tools` object is a lazy proxy — `Object.keys(tools)` won't work. Use `tools.search()` or `tools.executor.sources.list()` instead.",
    '- Pass an object to system tools, e.g. `tools.search({ query: "..." })`, `tools.executor.sources.list()`, and `tools.describe.tool({ path })`.',
    "- `tools.describe.tool()` returns compact TypeScript shapes. Use `inputTypeScript`, `outputTypeScript`, and `typeScriptDefinitions`.",
    "- For tools that return large collections (e.g. `getStates`, `getAll`), filter results in code rather than calling per-item tools.",
    "- Do not use `fetch` — all API calls go through `tools.*`.",
    "- If execution pauses for interaction, resume it with the returned `resumePayload`.",
    "- TypeScript type syntax (`: T`, `as T`, generics, interfaces, type aliases) is stripped before execution — feel free to write idiomatic TypeScript using the shapes from `tools.describe.tool()`. Decorators and `enum` are not supported.",
    "",
    "## Generative UI",
    "",
    "When it would be helpful to show an interactive UI, write a React component named `App` with JSX in the `code` parameter. It renders in an iframe alongside the conversation.",
    "",
    "**No imports** — everything is already in scope:",
    "- React: `useState`, `useEffect`, `useRef`, `useCallback`, `useMemo`",
    "- TanStack Query v5: `useQuery`, `useMutation`, `useQueryClient`, `queryOptions`, `mutationOptions`, `skipToken`; the component is already wrapped in `QueryClientProvider`.",
    "- Do not redeclare or destructure provided globals. Do not write `const { useState } = React`; use `useState(...)` directly or `React.useState(...)`.",
    "- Fetch live data with TanStack options from the tool proxy: `useQuery(tools.<namespace>.<tool>.queryOptions(args))`. Do not call tools before generating the UI and paste returned data into JSX.",
    "- For user-triggered writes or actions, use `useMutation(tools.<namespace>.<tool>.mutationOptions({ onSuccess }))` and call `mutate(input)` from event handlers.",
    "- Invalidate or refetch reads with `useQueryClient()` and stable keys from `tools.<namespace>.<tool>.queryKey(args)`.",
    "- Use the discovered output shape exactly. Do not invent wrapper fields like `data.domain` or `data.items` unless the schema/sample shows them.",
    "- For toggles and switches, mutate with the checked value from the event instead of inverting possibly stale query data.",
    "- For optimistic writes, use TanStack `onMutate` / `onError` / `onSettled`: cancel the query, snapshot old data, `setQueryData`, roll back on error, then invalidate.",
    "- Only hardcode small display constants like labels, colors, tab names, and chart configuration. Never embed tool response rows, API results, summaries, or dashboard data as literals in the component.",
    "- Always render loading and error states from `useQuery` / `useMutation`; do not replace them with hardcoded fallback data.",
    "- Tools: `tools.<namespace>.<tool>(args)` — call any configured API tool (never use raw `fetch`). Tool helpers: `.queryOptions(args, options)`, `.mutationOptions(options)`, `.queryKey(args)`, `.pathKey()`, and `.mutationKey()`.",
    "- shadcn/ui components available by name: Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Button, Input, Textarea, Label, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Checkbox, Switch, Slider, Toggle, Tabs, TabsList, TabsTrigger, TabsContent, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Badge, Avatar, AvatarFallback, Alert, AlertTitle, AlertDescription, Dialog, Sheet, Popover, Tooltip, Separator, ScrollArea, Skeleton, Progress, Accordion, AccordionItem, AccordionTrigger, AccordionContent, DropdownMenu + sub-components",
    "- Charts (Recharts): BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Legend, ChartContainer, ChartTooltip, ChartTooltipContent",
    "- Icons (Lucide): Plus, Minus, Check, X, Search, Loader2, AlertCircle, ExternalLink, Copy, Trash2, Edit, Settings, User, Globe, Star, TrendingUp, Activity, Database, Shield, Package, and more",
    "- Utility: `cn()` for className merging, `run(code)` escape hatch for multi-step tool composition",
    "- Use Tailwind classes for styling. The UI must look good in both light and dark mode — the user's system theme is applied automatically.",
    "- Always use `dark:` variants when applying custom colors: e.g. `bg-white dark:bg-gray-900`, `text-gray-900 dark:text-gray-100`. Or prefer theme variables that adapt automatically: `bg-background`, `text-foreground`, `bg-card`, `text-card-foreground`, `bg-muted`, `text-muted-foreground`, `bg-primary`, `text-primary-foreground`, `bg-secondary`, `text-secondary-foreground`, `bg-accent`, `text-accent-foreground`, `bg-destructive`, `border-border`, `ring-ring`.",
    "- Never use hardcoded colors without a `dark:` counterpart — e.g. `bg-gray-50` alone will look wrong in dark mode.",
    "- The UI container defaults to `maxHeight: 800` (pixels). Override by declaring `const config = { maxHeight: 400 }` for small widgets or `const config = { maxHeight: 1000 }` for large lists/tables.",
  ];

  if (sources.length > 0) {
    lines.push("");
    lines.push("## Available namespaces");
    lines.push("");
    const sorted = [...sources].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 50);
    for (const source of sorted) {
      lines.push(`- \`${source.id}\``);
    }
    if (sources.length > sorted.length) {
      lines.push(`- ... ${sources.length - sorted.length} more`);
    }
  }

  return lines.join("\n");
};
