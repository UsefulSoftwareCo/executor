import { Buffer } from "node:buffer";
import { Data, Effect } from "effect";
import { z } from "zod";

import { validToolKey } from "../pipeline/discover";
import { stableStringify } from "../pipeline/descriptor";

export class AppExecutorError extends Data.TaggedError("AppExecutorError")<{
  readonly message: string;
  readonly kind:
    | "bundle"
    | "collect"
    | "invoke"
    | "timeout"
    | "nondeterministic"
    | "input_validation"
    | "output_validation";
  readonly diagnostics?: readonly { readonly path: string; readonly message: string }[];
  readonly cause?: unknown;
}> {}

export interface CollectedTool {
  readonly toolName: string;
  readonly exportKey?: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly integrations: Readonly<Record<string, { readonly slug: string }>>;
  readonly annotations?: {
    readonly readOnly?: boolean;
    readonly destructive?: boolean;
    readonly requiresApproval?: boolean;
  };
}

export interface CollectedModule {
  readonly tools: readonly CollectedTool[];
}

export interface AppToolBridge {
  readonly call: (toolPath: string, args: unknown) => Promise<unknown>;
}

export interface InvokeOutcome {
  readonly output: unknown;
}

export interface AppToolExecutor {
  readonly collect: (
    bundle: string,
    input: { readonly fileSlug: string; readonly sourcePath: string },
  ) => Effect.Effect<CollectedModule, AppExecutorError>;
  readonly invoke: (
    bundle: string,
    entry: { readonly toolName: string },
    input: unknown,
    bridge: AppToolBridge,
    limits: { readonly timeoutMs: number },
  ) => Effect.Effect<InvokeOutcome, AppExecutorError>;
}

const EXECUTOR_INTEGRATION_META = "~executor";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const moduleUrl = (bundle: string): string =>
  `data:text/javascript;base64,${Buffer.from(bundle, "utf8").toString("base64")}#${crypto.randomUUID()}`;

const importBundle = (bundle: string): Promise<unknown> => import(moduleUrl(bundle));

const resolveDefault = async (bundle: string): Promise<unknown> => {
  const mod = (await importBundle(bundle)) as { readonly default?: unknown };
  const value = mod.default;
  return typeof value === "function" ? await (value as () => unknown | Promise<unknown>)() : value;
};

const toIssue = (
  issue: unknown,
): { readonly message: string; readonly path?: readonly unknown[] } => {
  if (isRecord(issue) && typeof issue.message === "string") {
    return {
      message: issue.message,
      ...(Array.isArray(issue.path) ? { path: issue.path } : {}),
    };
  }
  return { message: String(issue) };
};

const validateStandard = async (
  schema: unknown,
  value: unknown,
  field: "input" | "output",
): Promise<unknown> => {
  if (!isRecord(schema) || !isRecord(schema["~standard"])) return value;
  const validate = schema["~standard"].validate;
  if (typeof validate !== "function") return value;
  const result = await validate(value);
  if (isRecord(result) && "issues" in result && Array.isArray(result.issues)) {
    throw new AppExecutorError({
      kind: field === "input" ? "input_validation" : "output_validation",
      message: `${field} validation failed`,
      cause: result.issues.map(toIssue),
    });
  }
  return isRecord(result) && "value" in result ? result.value : value;
};

const jsonSchemaFor = (schema: unknown): unknown => {
  if (schema === undefined) return undefined;
  if (isRecord(schema) && isRecord(schema["~standard"])) {
    try {
      return z.toJSONSchema(schema as unknown as z.ZodType);
    } catch {
      return {};
    }
  }
  return schema;
};

const integrationMarker = (value: unknown): { readonly slug: string } | null => {
  if (!isRecord(value)) return null;
  const direct = value[EXECUTOR_INTEGRATION_META];
  if (isRecord(direct) && direct.kind === "integration" && typeof direct.slug === "string") {
    return { slug: direct.slug };
  }
  const meta = isRecord(value._def) ? value._def.metadata : undefined;
  const marker = isRecord(meta) ? meta[EXECUTOR_INTEGRATION_META] : undefined;
  return isRecord(marker) && marker.kind === "integration" && typeof marker.slug === "string"
    ? { slug: marker.slug }
    : null;
};

const shapeOf = (schema: unknown): Record<string, unknown> | null => {
  if (!isRecord(schema)) return null;
  const shape = schema.shape;
  if (isRecord(shape)) return shape;
  if (typeof shape === "function") {
    const out = shape();
    return isRecord(out) ? out : null;
  }
  return null;
};

const findNestedIntegration = (
  value: unknown,
  path: readonly string[],
): readonly string[] | null => {
  if (integrationMarker(value)) return path;
  const shape = shapeOf(value);
  if (shape) {
    for (const [key, child] of Object.entries(shape)) {
      const nested = findNestedIntegration(child, [...path, key]);
      if (nested) return nested;
    }
  }
  return null;
};

const collectIntegrations = (
  toolName: string,
  sourcePath: string,
  input: unknown,
): Readonly<Record<string, { readonly slug: string }>> => {
  const shape = shapeOf(input);
  if (!shape) return {};
  const out: Record<string, { readonly slug: string }> = {};
  for (const [field, fieldSchema] of Object.entries(shape)) {
    const marker = integrationMarker(fieldSchema);
    if (marker) {
      out[field] = marker;
      continue;
    }
    const nested = findNestedIntegration(fieldSchema, [field]);
    if (nested) {
      throw new AppExecutorError({
        kind: "collect",
        message: `tool "${toolName}" declares nested integration at "${nested.join(".")}"`,
        diagnostics: [
          {
            path: sourcePath,
            message: `integration() fields must be top-level input fields: ${nested.join(".")}`,
          },
        ],
      });
    }
  }
  return out;
};

const projectInputSchema = (schema: unknown): unknown => {
  const shape = shapeOf(schema);
  if (!shape) return jsonSchemaFor(schema);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [field, fieldSchema] of Object.entries(shape)) {
    const marker = integrationMarker(fieldSchema);
    if (marker) {
      properties[field] = {
        type: "string",
        description: `Connection address for ${marker.slug}`,
      };
      required.push(field);
    } else {
      properties[field] = jsonSchemaFor(fieldSchema);
    }
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
};

const isDefinedTool = (
  value: unknown,
): value is {
  readonly description: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly annotations?: CollectedTool["annotations"];
  readonly handler: (input: unknown, ctx: Record<string, never>) => unknown;
} =>
  isRecord(value) &&
  value["~executorAppTool"] === true &&
  typeof value.description === "string" &&
  "input" in value &&
  typeof value.handler === "function";

const collectFromExport = (
  exported: unknown,
  fileSlug: string,
  sourcePath: string,
): CollectedModule => {
  if (isDefinedTool(exported)) {
    return {
      tools: [
        {
          toolName: fileSlug,
          description: exported.description,
          integrations: collectIntegrations(fileSlug, sourcePath, exported.input),
          inputSchema: projectInputSchema(exported.input),
          outputSchema: jsonSchemaFor(exported.output),
          annotations: exported.annotations,
        },
      ],
    };
  }
  if (!isRecord(exported)) {
    throw new AppExecutorError({
      kind: "collect",
      message: `default export in ${sourcePath} must be a tool, record, or factory`,
      diagnostics: [{ path: sourcePath, message: "unsupported default export" }],
    });
  }
  const tools: CollectedTool[] = [];
  const seen = new Set<string>();
  if (isDefinedTool(exported[fileSlug])) {
    throw new AppExecutorError({
      kind: "collect",
      message: `record export key "${fileSlug}" collides with single tool name`,
      diagnostics: [{ path: sourcePath, message: `record key "${fileSlug}" is reserved` }],
    });
  }
  for (const [key, value] of Object.entries(exported)) {
    if (!isDefinedTool(value)) continue;
    if (!validToolKey(key)) {
      throw new AppExecutorError({
        kind: "collect",
        message: `record export key "${key}" is not a valid tool slug`,
        diagnostics: [{ path: sourcePath, message: `invalid record key "${key}"` }],
      });
    }
    const toolName = `${fileSlug}__${key}`;
    if (seen.has(toolName)) {
      throw new AppExecutorError({
        kind: "collect",
        message: `duplicate tool name "${toolName}"`,
        diagnostics: [{ path: sourcePath, message: `duplicate tool name "${toolName}"` }],
      });
    }
    seen.add(toolName);
    tools.push({
      toolName,
      exportKey: key,
      description: value.description,
      integrations: collectIntegrations(toolName, sourcePath, value.input),
      inputSchema: projectInputSchema(value.input),
      outputSchema: jsonSchemaFor(value.output),
      annotations: value.annotations,
    });
  }
  if (tools.length === 0) {
    throw new AppExecutorError({
      kind: "collect",
      message: `record export in ${sourcePath} contains no defineTool entries`,
      diagnostics: [{ path: sourcePath, message: "no tools found" }],
    });
  }
  return { tools };
};

const selectTool = (exported: unknown, entry: string): unknown => {
  if (isDefinedTool(exported)) return exported;
  if (!isRecord(exported)) return null;
  const marker = "__";
  const index = entry.indexOf(marker);
  if (index === -1) return null;
  return exported[entry.slice(index + marker.length)];
};

const timeout = <A>(promise: Promise<A>, timeoutMs: number): Promise<A> =>
  Promise.race([
    promise,
    new Promise<A>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new AppExecutorError({
              kind: "timeout",
              message: `app tool timed out after ${timeoutMs}ms`,
            }),
          ),
        timeoutMs,
      );
    }),
  ]);

const makeClient = (prefix: readonly string[], bridge: AppToolBridge): unknown =>
  new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return makeClient([...prefix, String(prop)], bridge);
    },
    apply(_target, _thisArg, args) {
      return bridge.call(prefix.join("."), args[0] ?? {});
    },
  });

/** In-process backing for unit tests only. It is not a security boundary. */
export const makeInProcessAppToolExecutor = (): AppToolExecutor => ({
  collect: (bundle, input) =>
    Effect.tryPromise({
      try: async () => {
        const first = collectFromExport(
          await resolveDefault(bundle),
          input.fileSlug,
          input.sourcePath,
        );
        const second = collectFromExport(
          await resolveDefault(bundle),
          input.fileSlug,
          input.sourcePath,
        );
        if (stableStringify(first) !== stableStringify(second)) {
          throw new AppExecutorError({
            kind: "nondeterministic",
            message: `collect for ${input.sourcePath} is nondeterministic`,
            diagnostics: [
              { path: input.sourcePath, message: "factory output changed between runs" },
            ],
          });
        }
        return first;
      },
      catch: (cause) =>
        cause instanceof AppExecutorError
          ? cause
          : new AppExecutorError({
              kind: "collect",
              message: `collect failed for ${input.sourcePath}`,
              cause,
            }),
    }),
  invoke: (bundle, entry, input, bridge, limits) =>
    Effect.tryPromise({
      try: async () =>
        timeout(
          (async () => {
            const exported = await resolveDefault(bundle);
            const tool = selectTool(exported, entry.toolName);
            if (!isDefinedTool(tool)) {
              throw new AppExecutorError({
                kind: "invoke",
                message: `tool not found in bundle: ${entry.toolName}`,
              });
            }
            const integrations = collectIntegrations(entry.toolName, entry.toolName, tool.input);
            const decoded = (await validateStandard(tool.input, input, "input")) as Record<
              string,
              unknown
            >;
            const handlerInput = { ...decoded };
            for (const field of Object.keys(integrations)) {
              handlerInput[field] = makeClient([], {
                call: (toolPath, args) => bridge.call(`${field}.${toolPath}`, args),
              });
            }
            const output = await tool.handler(handlerInput, {});
            return { output: await validateStandard(tool.output, output, "output") };
          })(),
          limits.timeoutMs,
        ),
      catch: (cause) =>
        cause instanceof AppExecutorError
          ? cause
          : new AppExecutorError({ kind: "invoke", message: "app tool invocation failed", cause }),
    }),
});
