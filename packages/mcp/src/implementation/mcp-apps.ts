// MCP Apps, SEP-1865: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
import { Effect, Option, Schema } from "effect";
import { McpSchema, type McpServer } from "effect/ai";
import { mcpUiExtension, mcpUiMimeType, mcpUiResourceTool } from "apps/contracts";
import { resolveLinkedAccounts, ToolName } from "@executor-js/sdk/core";
import type { McpBackend } from "../contracts/backend.ts";
import { CallOutcome, type McpExecutionResult } from "../contracts/execute.ts";
import { McpToolkit } from "../contracts/tools.ts";
import { discoveryAccounts } from "./accounts.ts";
import { callTools, listedTools, type Entry } from "./execute.ts";
import type { makeExecutions } from "./executions.ts";
import { executeNative } from "./native-elicitation.ts";

const scheme = "ui://executor/";
const upstreamScheme = "ui://";
export const uiListingMillis = 5_000;

const JsonRecord = Schema.Record(Schema.String, Schema.Json);
type JsonRecord = typeof JsonRecord.Type;
const isJsonRecord = Schema.is(JsonRecord);
const isRecord = (value: unknown): value is JsonRecord => isJsonRecord(value);

const uiOf = (meta: JsonRecord | undefined) => {
  if (meta === undefined) return undefined;
  const ui = isRecord(meta.ui) ? meta.ui : undefined;
  const flat = meta["ui/resourceUri"];
  if (ui === undefined && typeof flat !== "string") return undefined;
  const uri = typeof ui?.resourceUri === "string" ? ui.resourceUri : flat;
  return {
    ui: ui ?? {},
    resourceUri: typeof uri === "string" && uri.startsWith(upstreamScheme) ? uri : undefined,
  };
};

const namespaced = (slug: string, uri: string) =>
  `${scheme}${slug}/${uri.slice(upstreamScheme.length)}`;

const binding = (entry: Entry) => {
  const schema = entry.tool.inputSchema;
  const held = new Set<string>(
    Object.values(discoveryAccounts(entry.target.linked)?.user ?? {}).flatMap((ids) => ids),
  );
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isRecord) : [];
  const accounts = branches.flatMap((branch) => {
    const properties = isRecord(branch.properties) ? branch.properties : undefined;
    const choice = isRecord(properties?.accountId) ? properties.accountId : undefined;
    const ids = [
      ...(typeof choice?.const === "string" ? [choice.const] : []),
      ...(Array.isArray(choice?.enum)
        ? choice.enum.filter((id: unknown): id is string => typeof id === "string")
        : []),
    ];
    return ids.filter((id) => held.has(id)).map((id) => ({ id, input: properties?.input }));
  });
  if (accounts.length === 0) return { inputSchema: schema };
  const [only] = accounts;
  if (accounts.length > 1 || branches.length > 1 || only === undefined || !isRecord(only.input))
    return undefined;
  const input = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRecord))(
    JSON.stringify(only.input).replaceAll('"#/anyOf/0/properties/input', '"#'),
  );
  if (Option.isNone(input)) return undefined;
  const shared = schema.$defs;
  const own = input.value.$defs;
  return {
    accountId: only.id,
    inputSchema: {
      type: "object",
      ...input.value,
      ...(isRecord(shared) ? { $defs: { ...shared, ...(isRecord(own) ? own : {}) } } : {}),
    },
  };
};

interface UiTool {
  readonly entry: Entry;
  readonly name: string;
  readonly accountId?: string;
  readonly resourceUri?: string;
  readonly listed: boolean;
  readonly descriptor: McpSchema.Tool;
}

const leftOut = (reason: string, name: string) =>
  Effect.logWarning("Left an MCP Apps tool out of the tool list").pipe(
    Effect.annotateLogs({ reason, tool: name }),
  );

const upstreamName = (entry: Entry) => {
  const router = entry.tool.router;
  return router === undefined ? entry.tool.name : entry.tool.name.slice(router.length + 1);
};

const project = (entry: Entry) =>
  Effect.gen(function* () {
    const meta = uiOf(entry.tool._meta) ?? { ui: undefined, resourceUri: undefined };
    const name = upstreamName(entry);
    const bound = binding(entry);
    if (bound === undefined) {
      yield* leftOut("several-accounts", name);
      return undefined;
    }
    const resourceUri =
      meta.resourceUri === undefined ? undefined : namespaced(entry.target.slug, meta.resourceUri);
    const { "ui/resourceUri": flat, ...rest } = entry.tool._meta ?? {};
    const descriptor = Schema.decodeUnknownOption(McpSchema.Tool)({
      name,
      ...(entry.tool.title === undefined ? {} : { title: entry.tool.title }),
      description: entry.tool.description,
      inputSchema: bound.inputSchema,
      ...(entry.tool.annotations === undefined ? {} : { annotations: entry.tool.annotations }),
      _meta: {
        ...rest,
        ...(flat === undefined || resourceUri === undefined
          ? {}
          : { "ui/resourceUri": resourceUri }),
        ...(meta.ui === undefined
          ? {}
          : { ui: { ...meta.ui, ...(resourceUri === undefined ? {} : { resourceUri }) } }),
      },
    });
    if (Option.isNone(descriptor)) {
      yield* leftOut("invalid-descriptor", name);
      return undefined;
    }
    return {
      entry,
      name,
      ...(bound.accountId === undefined ? {} : { accountId: bound.accountId }),
      ...(meta.resourceUri === undefined ? {} : { resourceUri: meta.resourceUri }),
      listed: meta.ui !== undefined,
      descriptor: descriptor.value,
    } satisfies UiTool;
  });

const reserved: ReadonlySet<string> = new Set(Object.keys(McpToolkit.tools));

const uiTools = (backend: McpBackend<Error>) =>
  listedTools(backend, "all").pipe(
    Effect.map((entries) => {
      const withUi = new Set(
        entries.flatMap((entry) => (uiOf(entry.tool._meta) === undefined ? [] : [entry.target.id])),
      );
      return entries.filter((entry) => withUi.has(entry.target.id));
    }),
    Effect.flatMap((entries) => Effect.forEach(entries, project)),
    Effect.flatMap((projected) =>
      Effect.gen(function* () {
        const byName = new Map<string, Array<UiTool>>();
        for (const tool of projected) {
          if (tool === undefined) continue;
          byName.set(tool.name, [...(byName.get(tool.name) ?? []), tool]);
        }
        const tools = new Map<string, UiTool>();
        for (const [name, all] of [...byName].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
          const listed = all.filter((tool) => tool.listed);
          const found = listed.length > 0 ? listed : all;
          const [only] = found;
          if (reserved.has(name)) {
            if (listed.length > 0) yield* leftOut("executor-tool-name", name);
          } else if (found.length > 1 || only === undefined) {
            if (listed.length > 0) yield* leftOut("shared-name", name);
          } else tools.set(name, only);
        }
        return tools;
      }),
    ),
    Effect.timeoutOption(uiListingMillis),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logWarning("Left MCP Apps tools out: the caller's catalog took too long").pipe(
            Effect.as(new Map<string, UiTool>()),
          ),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catch((error) =>
      Effect.logWarning("Left MCP Apps tools out: the caller's catalog failed").pipe(
        Effect.annotateLogs({ error: error.name }),
        Effect.as(new Map<string, UiTool>()),
      ),
    ),
  );

const negotiated = Effect.map(McpSchema.McpRequestContext, ({ clientCapabilities }) => {
  const ui = clientCapabilities.extensions?.[mcpUiExtension];
  return isRecord(ui) && Array.isArray(ui.mimeTypes) && ui.mimeTypes.includes(mcpUiMimeType);
});

const failed = (text: string) =>
  McpSchema.CallToolResult.make({
    isError: true,
    content: [McpSchema.TextContent.make({ type: "text", text })],
  });

const unanswerable =
  "This call needs the user's approval or input, and this MCP client cannot show the request. Ask the agent to run it with the call tool.";

const callResult = (result: McpExecutionResult) =>
  Effect.gen(function* () {
    if (result.status !== "completed")
      return failed(`The call did not complete (${result.status}).`);
    const { execution } = result;
    if (!execution.ok) return failed(execution.error.message);
    const outcome = yield* Schema.decodeUnknownEffect(CallOutcome)(execution.value);
    if (!outcome.ok) return failed(outcome.error.message);
    const called = yield* Schema.decodeUnknownEffect(McpSchema.CallToolResult)(outcome.value);
    return called.content.length > 0 || called.structuredContent === undefined
      ? called
      : McpSchema.CallToolResult.make({
          ...called,
          content: [
            McpSchema.TextContent.make({
              type: "text",
              text: JSON.stringify(called.structuredContent),
            }),
          ],
        });
  }).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.succeed(failed("The tool returned a result that is not an MCP tool result.")),
    ),
  );

export const uiToolCatalog = (
  backend: McpBackend<Error>,
  executions: Effect.Success<ReturnType<typeof makeExecutions>>,
  caller: Effect.Effect<string>,
): McpServer.ToolCatalog<McpSchema.McpRequestContext> => ({
  list: Effect.gen(function* () {
    if (!(yield* negotiated)) return [];
    return [...(yield* uiTools(backend)).values()]
      .filter((tool) => tool.listed)
      .map((tool) => tool.descriptor);
  }),
  call: (name, args) =>
    Effect.gen(function* () {
      if (!(yield* negotiated)) return undefined;
      const tool = (yield* uiTools(backend)).get(name);
      if (tool === undefined) return undefined;
      const input = Schema.decodeUnknownOption(Schema.Json)(args);
      if (Option.isNone(input)) return failed("Tool arguments must be JSON.");
      const program = callTools({
        calls: {
          path: tool.entry.path,
          input:
            tool.accountId === undefined
              ? input.value
              : { accountId: tool.accountId, input: input.value },
        },
      });
      const id = yield* caller;
      const { clientCapabilities } = yield* McpSchema.McpRequestContext;
      const forms =
        clientCapabilities.elicitation !== undefined &&
        (clientCapabilities.elicitation.form !== undefined ||
          clientCapabilities.elicitation.url === undefined) &&
        Option.isSome(yield* Effect.serviceOption(McpSchema.McpServerClient));
      if (forms)
        return yield* executeNative(executions, id, backend, program, "ask").pipe(
          Effect.flatMap(callResult),
          Effect.catch((error) => Effect.succeed(failed(error.message))),
        );
      return yield* executions.execute(id, backend, program, "prompt", "ask").pipe(
        Effect.flatMap((result) =>
          result.status === "approval-required" || result.status === "input-required"
            ? executions.discard(id, result.requestId).pipe(Effect.as(failed(unanswerable)))
            : callResult(result),
        ),
        Effect.catch((error) => Effect.succeed(failed(error.message))),
      );
    }),
});

export const uiResourceCatalog = (
  backend: McpBackend<Error>,
): McpServer.ResourceCatalog<McpSchema.McpRequestContext> => ({
  read: (uri) =>
    Effect.gen(function* () {
      if (!uri.startsWith(scheme) || !(yield* negotiated)) return undefined;
      const [slug = "", ...path] = uri.slice(scheme.length).split("/");
      const upstream = `${upstreamScheme}${path.join("/")}`;
      const entries = yield* listedTools(backend, [slug]);
      const owners = yield* Effect.forEach(
        entries.filter((entry) => entry.target.slug === slug),
        project,
      );
      const owner = owners.find((tool) => tool?.resourceUri === upstream);
      if (owner === undefined) return undefined;
      const { entry } = owner;
      const accounts = yield* resolveLinkedAccounts({
        app: entry.target.id,
        version: entry.target.version,
        appLinks: {},
        userLinks: entry.target.linked,
      });
      const router = entry.tool.router;
      const input = { uri: upstream };
      const result = yield* backend.callTool({
        app: entry.target.id,
        accounts,
        tool: ToolName.make(
          router === undefined ? mcpUiResourceTool : `${router}.${mcpUiResourceTool}`,
        ),
        kind: "query",
        input: owner.accountId === undefined ? input : { accountId: owner.accountId, input },
      });
      if (result.status !== "completed")
        return yield* new McpSchema.InternalError({
          message: "Reading this resource needs approval, which an MCP Apps host cannot give.",
        });
      const read = yield* Schema.decodeUnknownEffect(JsonRecord)(result.value);
      const contents = Array.isArray(read.contents) ? read.contents : [];
      return yield* Schema.decodeUnknownEffect(McpSchema.ReadResourceResult)({
        ...read,
        contents: contents.map((content) =>
          isRecord(content) && content.uri === upstream ? { ...content, uri } : content,
        ),
      });
    }).pipe(
      Effect.catch((error) =>
        Schema.is(McpSchema.InternalError)(error)
          ? Effect.fail(error)
          : Effect.fail(
              new McpSchema.InternalError({
                message: `The app's server could not be read: ${error.message}`,
              }),
            ),
      ),
    ),
});
