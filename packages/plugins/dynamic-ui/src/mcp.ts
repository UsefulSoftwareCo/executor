import { Effect } from "effect";
import {
  getUiCapability,
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";

import {
  defineMcpContribution,
  type McpPluginContribution,
  type McpPluginRegisterContext,
  type McpToolResult,
} from "@executor-js/host-mcp";
import { loadDynamicUiShellHtml } from "./shell-html";

type ToggleableMcpRegistration = {
  enable: () => void;
  disable: () => void;
};

type McpAppsClientCapabilities = ClientCapabilities & {
  readonly extensions?: Record<string, unknown>;
};

export const DYNAMIC_UI_SHELL_RESOURCE_URI = "ui://executor/shell-tanstack-query.html";

const SHADCN_COMPONENTS =
  "Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Button, Input, Textarea, Label, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Checkbox, Switch, Slider, Toggle, Tabs, TabsList, TabsTrigger, TabsContent, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Badge, Avatar, AvatarFallback, Alert, AlertTitle, AlertDescription, Dialog, Sheet, Popover, Tooltip, Separator, ScrollArea, Skeleton, Progress, Accordion, AccordionItem, AccordionTrigger, AccordionContent, DropdownMenu + sub-components";

const RECHARTS_COMPONENTS =
  "BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Legend, ChartContainer, ChartTooltip, ChartTooltipContent";

const LUCIDE_ICONS =
  "Plus, Minus, Check, X, Search, Loader2, AlertCircle, ExternalLink, Copy, Trash2, Edit, Settings, User, Globe, Star, TrendingUp, Activity, Database, Shield, Package, and more";

const PROVIDED_GLOBAL_NAMES = new Set([
  "React",
  "useState",
  "useEffect",
  "useRef",
  "useCallback",
  "useMemo",
  "useContext",
  "Fragment",
  "createContext",
  "module",
  "exports",
  "require",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Worker",
  "SharedWorker",
  "useQuery",
  "useMutation",
  "useQueryClient",
  "queryOptions",
  "mutationOptions",
  "skipToken",
  "tools",
  "run",
  "Card",
  "CardHeader",
  "CardTitle",
  "CardDescription",
  "CardAction",
  "CardContent",
  "CardFooter",
  "Button",
  "Input",
  "Textarea",
  "Label",
  "Select",
  "SelectTrigger",
  "SelectValue",
  "SelectContent",
  "SelectItem",
  "Checkbox",
  "Switch",
  "Slider",
  "Toggle",
  "Tabs",
  "TabsList",
  "TabsTrigger",
  "TabsContent",
  "Table",
  "TableHeader",
  "TableBody",
  "TableRow",
  "TableHead",
  "TableCell",
  "Badge",
  "Avatar",
  "AvatarFallback",
  "Alert",
  "AlertTitle",
  "AlertDescription",
  "Dialog",
  "Sheet",
  "Popover",
  "Tooltip",
  "Separator",
  "ScrollArea",
  "Skeleton",
  "Progress",
  "Accordion",
  "AccordionItem",
  "AccordionTrigger",
  "AccordionContent",
  "ScrollBar",
  "DropdownMenu",
  "DialogTrigger",
  "DialogContent",
  "DialogHeader",
  "DialogFooter",
  "DialogTitle",
  "DialogDescription",
  "DialogClose",
  "SheetTrigger",
  "SheetContent",
  "SheetHeader",
  "SheetFooter",
  "SheetTitle",
  "SheetDescription",
  "SheetClose",
  "PopoverTrigger",
  "PopoverContent",
  "PopoverAnchor",
  "TooltipTrigger",
  "TooltipContent",
  "TooltipProvider",
  "DropdownMenuTrigger",
  "DropdownMenuContent",
  "DropdownMenuGroup",
  "DropdownMenuLabel",
  "DropdownMenuItem",
  "DropdownMenuCheckboxItem",
  "DropdownMenuRadioGroup",
  "DropdownMenuRadioItem",
  "DropdownMenuSeparator",
  "DropdownMenuSub",
  "DropdownMenuSubTrigger",
  "DropdownMenuSubContent",
  "SelectGroup",
  "SelectLabel",
  "RadioGroup",
  "RadioGroupItem",
  "ToggleGroup",
  "ToggleGroupItem",
  "TableFooter",
  "TableCaption",
  "AvatarImage",
  "BarChart",
  "Bar",
  "LineChart",
  "Line",
  "AreaChart",
  "Area",
  "PieChart",
  "Pie",
  "Cell",
  "RadarChart",
  "Radar",
  "PolarGrid",
  "PolarAngleAxis",
  "PolarRadiusAxis",
  "RadialBarChart",
  "RadialBar",
  "ScatterChart",
  "Scatter",
  "ComposedChart",
  "XAxis",
  "YAxis",
  "CartesianGrid",
  "ResponsiveContainer",
  "Legend",
  "ReferenceLine",
  "ReferenceArea",
  "Brush",
  "Funnel",
  "FunnelChart",
  "Treemap",
  "ChartContainer",
  "ChartTooltip",
  "ChartTooltipContent",
  "ChartLegend",
  "ChartLegendContent",
  "ChartStyle",
  "Plus",
  "Minus",
  "Check",
  "X",
  "ChevronDown",
  "ChevronUp",
  "ChevronLeft",
  "ChevronRight",
  "ChevronsUpDown",
  "Search",
  "Loader2",
  "AlertCircle",
  "AlertTriangle",
  "Info",
  "ExternalLink",
  "Copy",
  "Trash2",
  "Edit",
  "Settings",
  "User",
  "Users",
  "Mail",
  "Calendar",
  "Clock",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUpRight",
  "Download",
  "Upload",
  "File",
  "FileText",
  "Folder",
  "FolderOpen",
  "Image",
  "Link",
  "Globe",
  "Home",
  "Star",
  "Heart",
  "Eye",
  "EyeOff",
  "Lock",
  "Unlock",
  "RefreshCw",
  "RotateCcw",
  "Filter",
  "SortAsc",
  "SortDesc",
  "MoreHorizontal",
  "MoreVertical",
  "Menu",
  "Grip",
  "GripVertical",
  "Code",
  "Terminal",
  "TrendingUp",
  "TrendingDown",
  "BarChart3",
  "PieChartIcon",
  "GitBranch",
  "GitCommit",
  "GitPullRequest",
  "MessageSquare",
  "Send",
  "Bookmark",
  "Tag",
  "Hash",
  "AtSign",
  "Paperclip",
  "MapPin",
  "Phone",
  "Video",
  "Mic",
  "Volume2",
  "VolumeX",
  "Play",
  "Pause",
  "Square",
  "Circle",
  "Triangle",
  "Hexagon",
  "Box",
  "Activity",
  "Database",
  "Server",
  "Cpu",
  "Zap",
  "Shield",
  "Key",
  "Wifi",
  "WifiOff",
  "Battery",
  "Sun",
  "Moon",
  "CloudRain",
  "Thermometer",
  "Package",
  "cn",
]);

const sectionStart = (text: string, heading: string): number => {
  const withNewline = text.indexOf(`\n${heading}`);
  if (withNewline >= 0) return withNewline + 1;
  return text.startsWith(heading) ? 0 : -1;
};

export const availableNamespacesSection = (description: string): string | undefined => {
  const start = sectionStart(description, "## Available namespaces");
  return start >= 0 ? description.slice(start).trim() : undefined;
};

const extractGenerativeUiBody = (description: string): string | undefined => {
  const start = sectionStart(description, "## Generative UI");
  if (start < 0) return undefined;

  const namespaces = availableNamespacesSection(description);
  const end = namespaces ? description.indexOf(namespaces) : description.length;
  const section = description.slice(start, end).trim();
  return section.replace(/^## Generative UI\s*/, "").trim();
};

export const buildRenderUiDescription = (executeDescription: string): string => {
  const uiBody =
    extractGenerativeUiBody(executeDescription) ??
    [
      "Write a React component named `App` with JSX in the `code` parameter. It renders in an MCP app iframe alongside the conversation.",
      "",
      "**No imports** — everything is already in scope:",
      "- React: `useState`, `useEffect`, `useRef`, `useCallback`, `useMemo`",
      "- TanStack Query v5: `useQuery`, `useMutation`, `useQueryClient`, `queryOptions`, `mutationOptions`, `skipToken`; the component is already wrapped in `QueryClientProvider`.",
      "- Do not redeclare or destructure provided globals. Do not write `const { useState } = React`; use `useState(...)` directly or `React.useState(...)`.",
      "- Discovery: use the regular `execute` tool before calling `render-ui` when you need to inspect available tools, query syntax, response shapes, mutation inputs, IDs, field names, or example rows.",
      "- Fetch live data with TanStack options from the tool proxy: `useQuery(tools.<namespace>.<tool>.queryOptions(args))`.",
      "- For user-triggered writes, use `useMutation(tools.<namespace>.<tool>.mutationOptions({ onSuccess }))` and call `mutate(input)` from event handlers.",
      "- Invalidate or refetch reads with `useQueryClient()` and stable keys from `tools.<namespace>.<tool>.queryKey(args)`.",
      "- Use the discovered output shape exactly. Do not invent wrapper fields like `data.domain` or `data.items` unless the schema/sample shows them.",
      "- For toggles and switches, mutate with the checked value from the event instead of inverting possibly stale query data.",
      "- For optimistic writes, use TanStack `onMutate` / `onError` / `onSettled`: cancel the query, snapshot old data, `setQueryData`, roll back on error, then invalidate.",
      "- Only hardcode small display constants like labels, colors, tab names, and chart configuration. Never embed tool response rows, API results, summaries, or dashboard data as literals in the component.",
      "- Always render loading and error states from `useQuery` / `useMutation`; do not replace them with hardcoded fallback data.",
      `- shadcn/ui components available by name: ${SHADCN_COMPONENTS}`,
      `- Recharts components available by name: ${RECHARTS_COMPONENTS}`,
      `- Lucide icons available by name: ${LUCIDE_ICONS}`,
    ].join("\n");

  const namespaces = availableNamespacesSection(executeDescription);
  return [
    "Render an interactive React UI component in an MCP app iframe.",
    "",
    "## Workflow",
    "",
    "1. If you need to understand tool names, query syntax, required arguments, response shapes, IDs, or mutation inputs, first use the regular `execute` tool to inspect them.",
    "2. Then call `render-ui` with a component named `App` in the `code` parameter.",
    "3. Recreate every read from the discovery step inside `App` with `useQuery(tools.<namespace>.<tool>.queryOptions(args))` so the UI stays live.",
    "4. Use `useMutation(tools.<namespace>.<tool>.mutationOptions({ onSuccess }))` for user-triggered writes or actions.",
    "5. Return only the component code.",
    "",
    "## Using Execute For Discovery",
    "",
    "- `execute` is for exploration: list datasets, inspect schemas, test a query, fetch one small sample row, or learn the exact mutation input shape.",
    "- `render-ui` is for the final interactive surface. Do not paste discovery results into JSX as literal rows, cards, summaries, metrics, or chart series.",
    "- After discovering an API call with `execute`, put the same call in TanStack Query options inside the generated component.",
    "- Example discovery: call `execute` with `return await tools.axiom_mcp.querydataset({ ... })` to confirm columns, then call `render-ui` with `useQuery(tools.axiom_mcp.querydataset.queryOptions({ ... }))`.",
    "- Use discovered result shapes exactly. If a sample or schema returns `{ renew, expiresAt }`, read `data?.renew`, not `data?.domain?.renew`.",
    "- Keep discovery small. Use limits, narrow time ranges, or schema/list tools when possible.",
    "",
    "## TanStack Query State",
    "",
    "- Use `const queryClient = useQueryClient()` when a mutation changes data shown by a query.",
    "- For simple writes, invalidate with `queryClient.invalidateQueries(tools.<namespace>.<queryTool>.queryFilter(args))` in `onSuccess` or `onSettled`.",
    "- For toggles and switches, pass the new checked value into `mutate`: `onCheckedChange={(checked) => mutation.mutate({ body: { enabled: checked } })}`.",
    "- For optimistic UI, use `onMutate` to `cancelQueries`, snapshot `getQueryData`, and `setQueryData`; return the snapshot, restore it in `onError`, and invalidate in `onSettled`.",
    "",
    "## Available UI Components",
    "",
    `- shadcn/ui components available by name: ${SHADCN_COMPONENTS}`,
    `- Recharts components available by name: ${RECHARTS_COMPONENTS}`,
    `- Lucide icons available by name: ${LUCIDE_ICONS}`,
    "",
    "## Rules",
    "",
    "- Use this tool instead of `execute` whenever the output should be an interactive UI.",
    "- Do not call API tools first and paste returned data into JSX.",
    "- Do not embed tool response rows, API results, summaries, dashboard data, or copied query output as literals in the component.",
    "- Keep data live by routing every API read/write through the provided `tools` proxy from TanStack Query or `run(code)`.",
    "- Do not redeclare or destructure provided globals. Hooks, components, icons, `tools`, and `run` are already in scope; use them directly.",
    "- Tool proxy helpers are TanStack-native: `.queryOptions(args, options)`, `.mutationOptions(options)`, `.queryKey(args)`, `.queryFilter(args, filters)`, `.pathKey()`, `.pathFilter(filters)`, and `.mutationKey()`.",
    "- The server rejects obvious hardcoded live-data snapshots such as `const rows = [{...}, {...}]`; regenerate with `useQuery` instead.",
    "- The server rejects redeclarations of provided globals such as `const { useState } = React` or `const Card = ...` before the UI reaches the iframe.",
    "",
    "## Generative UI",
    "",
    uiBody,
    ...(namespaces ? ["", namespaces] : []),
  ].join("\n");
};

const DATA_SNAPSHOT_NAME =
  /(?:^|_|\b)(?:data|rows|items|results|records|datasets|dashboards|logs|events|metrics|traces|services|endpoints|series|points|stats|summary|requests|errors|users|issues|tickets)(?:$|_|\b)/i;

const OBJECT_ARRAY_LITERAL =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[((?:[^\][{}]|\{[^{}]*\})*)\]/gs;

const REACT_DESTRUCTURING_DECLARATION = /\b(?:const|let|var)\s*\{[^{}]*\}\s*=\s*React\b/s;

const OBJECT_DESTRUCTURING_DECLARATION = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=/gs;

const PROVIDED_GLOBAL_DECLARATION =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b|\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\bclass\s+([A-Za-z_$][\w$]*)\b/g;

const firstDefined = (...values: Array<string | undefined>): string | undefined =>
  values.find((value): value is string => value !== undefined);

const localDestructuredName = (part: string): string | undefined => {
  const binding = part
    .replace(/^\s*\.\.\./, "")
    .split("=")[0]
    ?.trim();
  const alias = binding?.match(/:\s*([A-Za-z_$][\w$]*)\s*$/)?.[1];
  return alias ?? binding?.match(/^([A-Za-z_$][\w$]*)\b/)?.[1];
};

export const validateRenderUiCode = (code: string): string | null => {
  if (REACT_DESTRUCTURING_DECLARATION.test(code)) {
    return [
      "Do not destructure React in render-ui.",
      "Hooks such as useState are already in scope; use useState(...) directly or React.useState(...).",
    ].join(" ");
  }

  for (const match of code.matchAll(OBJECT_DESTRUCTURING_DECLARATION)) {
    const names = match[1]?.split(",").flatMap((part) => {
      const name = localDestructuredName(part);
      return name ? [name] : [];
    });
    const providedName = names?.find((name) => PROVIDED_GLOBAL_NAMES.has(name));
    if (providedName) {
      return [
        `Provided global "${providedName}" is already in scope and cannot be redeclared.`,
        "Remove the destructuring declaration and use the provided global directly.",
      ].join(" ");
    }
  }

  for (const match of code.matchAll(PROVIDED_GLOBAL_DECLARATION)) {
    const name = firstDefined(match[1], match[2], match[3]);
    if (name && PROVIDED_GLOBAL_NAMES.has(name)) {
      return [
        `Provided global "${name}" is already in scope and cannot be redeclared.`,
        "Remove the local declaration and use the provided global directly.",
      ].join(" ");
    }
  }

  for (const match of code.matchAll(OBJECT_ARRAY_LITERAL)) {
    const name = match[1];
    const body = match[2] ?? "";
    const objectCount = body.match(/\{/g)?.length ?? 0;
    if (DATA_SNAPSHOT_NAME.test(name) && objectCount >= 2) {
      return [
        `Hardcoded live-data array "${name}" is not allowed in render-ui.`,
        "Fetch the data inside App with useQuery(tools.<namespace>.<tool>.queryOptions(args)) and derive rows/cards/charts from the query result.",
      ].join(" ");
    }
  }

  return null;
};

const toMcpRenderUiRejectedResult = (reason: string): McpToolResult => ({
  content: [{ type: "text", text: `Render UI rejected: ${reason}` }],
  structuredContent: { status: "error", error: reason },
  isError: true,
});

export const dynamicUiMcpContribution = (): McpPluginContribution => {
  let renderUiTool: ToggleableMcpRegistration | undefined;
  let executeActionTool: ToggleableMcpRegistration | undefined;
  let executeActionResumeTool: ToggleableMcpRegistration | undefined;
  let appsEnabled = false;

  return defineMcpContribution({
    id: "dynamic-ui",
    register: (ctx: McpPluginRegisterContext) =>
      Effect.sync(() => {
        renderUiTool = registerAppTool(
          ctx.server,
          "render-ui",
          {
            description: buildRenderUiDescription(ctx.description),
            inputSchema: { code: z.string().trim().min(1) },
            _meta: {
              ui: {
                resourceUri: DYNAMIC_UI_SHELL_RESOURCE_URI,
                visibility: ["model"],
              },
            },
          },
          ({ code }) => {
            const rejection = validateRenderUiCode(code);
            if (rejection) {
              return Promise.resolve(toMcpRenderUiRejectedResult(rejection));
            }

            if (!appsEnabled) {
              const url = ctx.renderUiFallbackUrl?.(code);
              return Promise.resolve(
                url
                  ? ({
                      content: [
                        {
                          type: "text" as const,
                          text: `Rendered interactive UI component. Open this URL to view it in Executor:\n${url}`,
                        },
                      ],
                      structuredContent: { status: "fallback_url", url },
                    } satisfies McpToolResult)
                  : ({
                      content: [
                        {
                          type: "text" as const,
                          text: "Rendered interactive UI component, but this MCP client cannot display MCP Apps and no Executor fallback URL is configured.",
                        },
                      ],
                      structuredContent: {
                        status: "fallback_unavailable",
                        reason: "mcp_apps_unsupported",
                      },
                      isError: true,
                    } satisfies McpToolResult),
              );
            }

            return Promise.resolve({
              content: [{ type: "text" as const, text: "Rendered interactive UI component." }],
              structuredContent: { code },
            } satisfies McpToolResult);
          },
        );

        executeActionTool = registerAppTool(
          ctx.server,
          "execute-action",
          {
            description:
              "Execute code from the UI shell. Used by interactive components to call tools and run mutations.",
            inputSchema: { code: z.string().trim().min(1) },
            _meta: {
              ui: {
                resourceUri: DYNAMIC_UI_SHELL_RESOURCE_URI,
                visibility: ["app"],
              },
            },
          },
          ({ code }) => ctx.runToolEffect(ctx.executeCodeFromApp(code)),
        );

        executeActionResumeTool = registerAppTool(
          ctx.server,
          "execute-action-resume",
          {
            description: "Resume an interactive UI action after shell-owned user approval.",
            inputSchema: {
              executionId: z.string().describe("The execution ID from the paused UI action"),
              action: z
                .enum(["accept", "decline", "cancel"])
                .describe("How to respond to the interaction"),
              content: z
                .string()
                .describe("Optional JSON-encoded response content for form elicitations")
                .default("{}"),
            },
            _meta: {
              ui: {
                resourceUri: DYNAMIC_UI_SHELL_RESOURCE_URI,
                visibility: ["app"],
              },
            },
          },
          ({ executionId, action, content: rawContent }) =>
            ctx.runToolEffect(
              ctx.resumeExecution(executionId, action, ctx.parseJsonContent(rawContent)),
            ),
        );

        registerAppResource(
          ctx.server,
          "Executor Shell",
          DYNAMIC_UI_SHELL_RESOURCE_URI,
          { mimeType: RESOURCE_MIME_TYPE },
          async () => {
            const html = await loadDynamicUiShellHtml();
            return {
              contents: [
                {
                  uri: DYNAMIC_UI_SHELL_RESOURCE_URI,
                  mimeType: RESOURCE_MIME_TYPE,
                  text: html,
                  _meta: {
                    ui: {
                      csp: {
                        connectDomains: [],
                        resourceDomains: [],
                      },
                    },
                  },
                },
              ],
            };
          },
        );
      }).pipe(Effect.withSpan("mcp.host.dynamic_ui.register")),
    onClientCapabilitiesChanged: ({ clientCapabilities, debugLog }) => {
      const uiCap = getUiCapability(clientCapabilities as McpAppsClientCapabilities | undefined);
      appsEnabled = Boolean(uiCap?.mimeTypes?.includes(RESOURCE_MIME_TYPE));

      if (appsEnabled) {
        renderUiTool?.enable();
        executeActionTool?.enable();
        executeActionResumeTool?.enable();
      } else {
        renderUiTool?.enable();
        executeActionTool?.disable();
        executeActionResumeTool?.disable();
      }

      debugLog("dynamic_ui.visibility", {
        appsSupport: uiCap ?? null,
        renderUiEnabled: true,
        executeActionEnabled: appsEnabled,
      });
    },
  });
};
