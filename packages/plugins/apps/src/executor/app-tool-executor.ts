/* oxlint-disable executor/no-try-catch-or-throw, executor/no-double-cast, executor/no-promise-reject, executor/no-instanceof-tagged-error -- boundary: in-process dynamic-import backing converts JavaScript exceptions into typed AppExecutorError */
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
  readonly integrations: Readonly<
    Record<
      string,
      {
        readonly slug: string;
        readonly mode: "one" | "many";
        readonly all: boolean;
        readonly description?: string;
      }
    >
  >;
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

type CollectedIntegrationDecl = CollectedTool["integrations"][string];

const integrationDeclaration = (value: unknown): CollectedIntegrationDecl | null => {
  if (!isRecord(value)) return null;
  if (value.kind !== "integration") return null;
  if (typeof value.slug !== "string" || (value.mode !== "one" && value.mode !== "many")) {
    return null;
  }
  return {
    slug: value.slug,
    mode: value.mode,
    all: value.allConnections === true,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
  };
};

const collectIntegrations = (
  toolName: string,
  sourcePath: string,
  declarations: unknown,
  inputJsonSchema: unknown,
): CollectedTool["integrations"] => {
  if (declarations === undefined) return {};
  if (!isRecord(declarations)) {
    throw new AppExecutorError({
      kind: "collect",
      message: `tool "${toolName}" integrations must be a record`,
      diagnostics: [{ path: sourcePath, message: "integrations must be a record" }],
    });
  }
  const inputProperties =
    isRecord(inputJsonSchema) && isRecord(inputJsonSchema.properties)
      ? inputJsonSchema.properties
      : {};
  const out: Record<string, CollectedIntegrationDecl> = {};
  for (const [field, raw] of Object.entries(declarations)) {
    if (Object.prototype.hasOwnProperty.call(inputProperties, field)) {
      throw new AppExecutorError({
        kind: "collect",
        message: `tool "${toolName}" integration key "${field}" collides with input field`,
        diagnostics: [
          { path: sourcePath, message: `integration key collides with input: ${field}` },
        ],
      });
    }
    const decl = integrationDeclaration(raw);
    if (!decl) {
      throw new AppExecutorError({
        kind: "collect",
        message: `tool "${toolName}" integration "${field}" is not a valid declaration`,
        diagnostics: [{ path: sourcePath, message: `invalid integration declaration: ${field}` }],
      });
    }
    if (decl.mode === "one" && decl.all) {
      throw new AppExecutorError({
        kind: "collect",
        message: `tool "${toolName}" integration "${field}" calls .all() without .array()`,
        diagnostics: [{ path: sourcePath, message: `.all() requires .array(): ${field}` }],
      });
    }
    out[field] = decl;
  }
  return out;
};

const projectInputSchema = (
  inputJsonSchema: unknown,
  integrations: CollectedTool["integrations"],
): unknown => {
  const base = isRecord(inputJsonSchema) ? inputJsonSchema : {};
  const properties = isRecord(base.properties) ? { ...base.properties } : {};
  const required = Array.isArray(base.required) ? [...base.required] : [];
  for (const [field, decl] of Object.entries(integrations)) {
    if (decl.mode === "one") {
      properties[field] = {
        type: "string",
        description: decl.description ?? `Connection for ${decl.slug}`,
      };
      required.push(field);
    } else {
      properties[field] = {
        type: "array",
        items: { type: "string" },
        description: decl.description ?? `Connections for ${decl.slug}`,
      };
      if (!decl.all) required.push(field);
    }
  }
  return {
    ...base,
    type: "object",
    properties,
    ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
  };
};

const isDefinedTool = (
  value: unknown,
): value is {
  readonly description: string;
  readonly integrations?: unknown;
  readonly input: unknown;
  readonly output?: unknown;
  readonly annotations?: CollectedTool["annotations"];
  readonly handler: (input: unknown, ctx: Record<string, unknown>) => unknown;
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
    const inputJsonSchema = jsonSchemaFor(exported.input);
    const integrations = collectIntegrations(
      fileSlug,
      sourcePath,
      exported.integrations,
      inputJsonSchema,
    );
    return {
      tools: [
        {
          toolName: fileSlug,
          description: exported.description,
          integrations,
          inputSchema: projectInputSchema(inputJsonSchema, integrations),
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
    const inputJsonSchema = jsonSchemaFor(value.input);
    const integrations = collectIntegrations(
      toolName,
      sourcePath,
      value.integrations,
      inputJsonSchema,
    );
    seen.add(toolName);
    tools.push({
      toolName,
      exportKey: key,
      description: value.description,
      integrations,
      inputSchema: projectInputSchema(inputJsonSchema, integrations),
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

const makeClient = (root: string, prefix: readonly string[], bridge: AppToolBridge): unknown =>
  new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return makeClient(root, [...prefix, String(prop)], bridge);
    },
    apply(_target, _thisArg, args) {
      return bridge.call(`${root}.${prefix.join(".")}`, args[0] ?? {});
    },
  });

const splitInvokeInput = (
  toolName: string,
  input: unknown,
  integrations: CollectedTool["integrations"],
  bridge: AppToolBridge,
): { readonly input: Record<string, unknown>; readonly integrations: Record<string, unknown> } => {
  const payload = isRecord(input) ? input : {};
  const dataInput: Record<string, unknown> = { ...payload };
  const handles: Record<string, unknown> = {};
  for (const [field, decl] of Object.entries(integrations)) {
    const raw = payload[field];
    delete dataInput[field];
    if (decl.mode === "one") {
      if (typeof raw !== "string" || raw.length === 0) {
        throw new AppExecutorError({
          kind: "input_validation",
          message: `tool "${toolName}" integration "${field}" must be a connection address`,
        });
      }
      handles[field] = makeClient(field, [], bridge);
      continue;
    }
    if (raw === undefined && decl.all) {
      handles[field] = [];
      continue;
    }
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new AppExecutorError({
        kind: "input_validation",
        message: `tool "${toolName}" integration "${field}" must be connection addresses`,
      });
    }
    handles[field] = raw.map((_address, index) => makeClient(`${field}#${index}`, [], bridge));
  }
  return { input: dataInput, integrations: handles };
};

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
            const inputJsonSchema = jsonSchemaFor(tool.input);
            const integrations = collectIntegrations(
              entry.toolName,
              entry.toolName,
              tool.integrations,
              inputJsonSchema,
            );
            const split = splitInvokeInput(entry.toolName, input, integrations, bridge);
            const decoded = await validateStandard(tool.input, split.input, "input");
            const output = await tool.handler(decoded, split.integrations);
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
