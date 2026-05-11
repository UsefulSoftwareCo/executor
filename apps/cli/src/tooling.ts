import * as Effect from "effect/Effect";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stripRepeatedErrorPrefix = (input: string): string => {
  let output = input.trim();
  while (output.toLowerCase().startsWith("error:")) {
    output = output.slice("error:".length).trimStart();
  }
  return output;
};

export const sanitizeCliOutputText = (input: string): string =>
  input
    // oxlint-disable-next-line eslint/no-control-regex -- boundary: CLI output sanitizer intentionally strips OSC control sequences
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    // oxlint-disable-next-line eslint/no-control-regex -- boundary: CLI output sanitizer intentionally strips ANSI control sequences
    .replace(/\u001b[@-_][0-?]*[ -/]*[@-~]/gu, "")
    // oxlint-disable-next-line eslint/no-control-regex -- boundary: CLI output sanitizer intentionally strips remaining control characters
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");

const TOOL_PATH_TOKEN = /^[A-Za-z0-9._-]+$/;

const toToolPathSegments = (parts: ReadonlyArray<string>): ReadonlyArray<string> =>
  parts
    .flatMap((part) => part.split("."))
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

const isPrefixOf = (prefix: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean =>
  prefix.every((segment, index) => path[index] === segment);

export interface ToolPathChildEntry {
  readonly segment: string;
  readonly invokable: boolean;
  readonly hasChildren: boolean;
  readonly toolCount: number;
}

export interface ToolPathInspection {
  readonly prefixSegments: ReadonlyArray<string>;
  readonly exactPath: string | undefined;
  readonly matchingToolCount: number;
  readonly children: ReadonlyArray<ToolPathChildEntry>;
}

export const inspectToolPath = (input: {
  toolPaths: ReadonlyArray<string>;
  rawPrefixParts: ReadonlyArray<string>;
}): ToolPathInspection => {
  const prefixSegments =
    input.rawPrefixParts.length === 0 ? [] : buildToolPath(input.rawPrefixParts).split(".");
  const children = new Map<
    string,
    { invokable: boolean; hasChildren: boolean; toolCount: number }
  >();
  let exactPath: string | undefined = undefined;
  let matchingToolCount = 0;

  for (const path of input.toolPaths) {
    const segments = toToolPathSegments([path]);
    if (segments.length === 0 || !isPrefixOf(prefixSegments, segments)) {
      continue;
    }

    matchingToolCount += 1;

    if (segments.length === prefixSegments.length) {
      exactPath = exactPath ?? segments.join(".");
      continue;
    }

    const childSegment = segments[prefixSegments.length];
    if (!childSegment) continue;

    const existing = children.get(childSegment) ?? {
      invokable: false,
      hasChildren: false,
      toolCount: 0,
    };
    children.set(childSegment, {
      invokable: existing.invokable || segments.length === prefixSegments.length + 1,
      hasChildren: existing.hasChildren || segments.length > prefixSegments.length + 1,
      toolCount: existing.toolCount + 1,
    });
  }

  const sortedChildren: ReadonlyArray<ToolPathChildEntry> = [...children.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([segment, value]) => ({
      segment,
      invokable: value.invokable,
      hasChildren: value.hasChildren,
      toolCount: value.toolCount,
    }));

  return {
    prefixSegments,
    exactPath,
    matchingToolCount,
    children: sortedChildren,
  };
};

export const buildToolPath = (parts: ReadonlyArray<string>): string => {
  const segments = toToolPathSegments(parts);
  if (segments.length === 0) {
    throw new Error("Tool path must include at least one segment");
  }
  if (segments.some((segment) => !TOOL_PATH_TOKEN.test(segment))) {
    throw new Error("Tool path segments must contain only letters, numbers, '.', '_' or '-'");
  }
  return segments.join(".");
};

const buildToolAccessExpression = (toolPath: string): string => {
  const segments = toToolPathSegments([toolPath]);
  if (segments.length === 0) {
    throw new Error("Tool path must include at least one segment");
  }
  return segments.map((segment) => `[${JSON.stringify(segment)}]`).join("");
};

export const parseJsonObjectInput = (
  raw: string | undefined,
): Effect.Effect<Record<string, unknown>, Error> =>
  Effect.gen(function* () {
    if (raw === undefined || raw.trim().length === 0) {
      return {};
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        cause instanceof Error
          ? new Error(`Invalid JSON arguments: ${cause.message}`)
          : new Error(`Invalid JSON arguments: ${String(cause)}`),
    });

    if (!isRecord(parsed)) {
      return yield* Effect.fail(new Error("Tool arguments must decode to a JSON object"));
    }

    return parsed;
  });

export const extractExecutionResult = (structured: unknown): unknown => {
  if (!isRecord(structured) || !("result" in structured)) {
    return null;
  }
  return structured.result;
};

export const extractExecutionId = (structured: unknown): string | undefined => {
  if (!isRecord(structured) || typeof structured.executionId !== "string") {
    return undefined;
  }
  return structured.executionId;
};

export const normalizeCliErrorText = (raw: string): string => {
  const lines = raw.split(/\r?\n/);
  const compacted: Array<string> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (compacted.length > 0 && compacted[compacted.length - 1] !== "") {
        compacted.push("");
      }
      continue;
    }
    if (/^at\s+/.test(trimmed)) continue;
    if (/^From previous event/.test(trimmed)) continue;
    compacted.push(trimmed);
  }

  if (compacted.length === 0) {
    return stripRepeatedErrorPrefix(raw);
  }

  compacted[0] = stripRepeatedErrorPrefix(compacted[0] ?? "");
  while (compacted.length > 0 && compacted[0]?.length === 0) {
    compacted.shift();
  }

  const limited = compacted.slice(0, 24);
  return limited.join("\n").trim();
};

export interface PausedInteraction {
  readonly kind: "url" | "form";
  readonly message: string;
  readonly url?: string;
  readonly requestedSchema?: Record<string, unknown>;
}

export const extractPausedInteraction = (structured: unknown): PausedInteraction | undefined => {
  if (!isRecord(structured) || !isRecord(structured.interaction)) {
    return undefined;
  }

  const interaction = structured.interaction;
  if (
    (interaction.kind !== "url" && interaction.kind !== "form") ||
    typeof interaction.message !== "string"
  ) {
    return undefined;
  }

  const base: PausedInteraction = {
    kind: interaction.kind,
    message: interaction.message,
  };

  if (interaction.kind === "url" && typeof interaction.url === "string") {
    return { ...base, url: interaction.url };
  }

  if (interaction.kind === "form" && isRecord(interaction.requestedSchema)) {
    return { ...base, requestedSchema: interaction.requestedSchema };
  }

  return base;
};

const schemaExample = (schema: unknown, depth = 0): unknown => {
  if (!isRecord(schema) || depth > 4) return {};

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  const candidate = Array.isArray(schema.oneOf)
    ? schema.oneOf[0]
    : Array.isArray(schema.anyOf)
      ? schema.anyOf[0]
      : Array.isArray(schema.allOf)
        ? schema.allOf[0]
        : undefined;

  if (candidate !== undefined) {
    return schemaExample(candidate, depth + 1);
  }

  if (schema.type === "string") return "<string>";
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "array") return [];

  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (schema.type === "object" || properties) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : undefined;
    const keys = Object.keys(properties ?? {});
    const selectedKeys = required && required.length > 0 ? required : keys;
    const result: Record<string, unknown> = {};
    for (const key of selectedKeys) {
      const value = properties?.[key];
      result[key] = schemaExample(value, depth + 1);
    }
    return result;
  }

  return {};
};

export const buildResumeContentTemplate = (
  requestedSchema: Record<string, unknown> | undefined,
): Record<string, unknown> => schemaExample(requestedSchema ?? {}) as Record<string, unknown>;

export const shellQuoteArg = (value: string): string => {
  if (/^[A-Za-z0-9_/:=@%+.,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
};

const tokenizeSegment = (input: string): ReadonlyArray<string> =>
  input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);

const tokenVariants = (input: string): ReadonlyArray<string> => {
  const token = input.toLowerCase();
  const variants = new Set<string>([token]);

  if (token.endsWith("ies") && token.length > 3) {
    variants.add(`${token.slice(0, -3)}y`);
  } else if (token.endsWith("s") && token.length > 1) {
    variants.add(token.slice(0, -1));
  } else {
    variants.add(`${token}s`);
    if (token.endsWith("y") && token.length > 1) {
      variants.add(`${token.slice(0, -1)}ies`);
    }
  }

  return [...variants];
};

const segmentMatchesToken = (segment: string, queryToken: string): boolean => {
  const normalizedSegment = segment.toLowerCase();
  const segmentTokens = tokenizeSegment(segment);
  const variants = tokenVariants(queryToken);
  return variants.some((variant) => {
    if (normalizedSegment.includes(variant)) return true;
    return segmentTokens.some((token) => token === variant || token.startsWith(variant));
  });
};

export const filterToolPathChildren = (
  children: ReadonlyArray<ToolPathChildEntry>,
  query: string | undefined,
): ReadonlyArray<ToolPathChildEntry> => {
  if (!query || query.trim().length === 0) {
    return children;
  }
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return children;
  }
  return children.filter((child) =>
    tokens.every((token) => segmentMatchesToken(child.segment, token)),
  );
};

export const buildSearchToolsCode = (input: {
  query: string;
  namespace?: string;
  limit: number;
}): string => {
  const payload: Record<string, unknown> = {
    query: input.query,
    limit: input.limit,
  };
  if (input.namespace && input.namespace.trim().length > 0) {
    payload.namespace = input.namespace;
  }
  return `return await tools.search(${JSON.stringify(payload)});`;
};

export const buildListSourcesCode = (input: { query?: string; limit: number }): string => {
  const payload: Record<string, unknown> = {
    limit: input.limit,
  };
  if (input.query && input.query.trim().length > 0) {
    payload.query = input.query;
  }
  return `return await tools.executor.sources.list(${JSON.stringify(payload)});`;
};

export const buildDescribeToolCode = (toolPath: string): string =>
  `return await tools.describe.tool({ path: ${JSON.stringify(toolPath)} });`;

export const buildInvokeToolCode = (toolPath: string, args: Record<string, unknown>): string => {
  const access = buildToolAccessExpression(toolPath);
  return [
    `const __toolPath = ${JSON.stringify(toolPath)};`,
    `const __args = ${JSON.stringify(args, null, 2)};`,
    `const __target = tools${access};`,
    `if (typeof __target !== "function") {`,
    "  throw new Error(`Tool not found: ${__toolPath}`);",
    "}",
    "return await __target(__args);",
  ].join("\n");
};
