import { accountProviderError } from "./provider-error.ts";
/** Combine account-bound protocol operations without changing their upstream inputs. */
import { Effect, Schema } from "effect";
import { HostedTool, HostedToolSummary } from "../contracts/host.ts";
import type { AppOperation } from "../contracts/operations.ts";
import type { AppNode, AppRouter, DynamicRouter } from "../contracts/router.ts";
import { JsonObject } from "../contracts/schema.ts";
import { nativeOperation, operationDeclaration } from "./operations.ts";
import { nativeRouter, routerDeclaration, type RouterDeclaration } from "./router.ts";
import { importedJsonSchema, nestJsonSchema, once, withLazyJsonSchemaDocument } from "./schema.ts";

type Selection = { readonly accountId: string; readonly input: unknown };

const decoderDocument = (decoder: Schema.Decoder<unknown>) => {
  const imported = importedJsonSchema(decoder);
  if (imported !== undefined) return Schema.decodeUnknownSync(JsonObject)(imported);
  const document = Schema.toJsonSchemaDocument(decoder);
  return Schema.decodeUnknownSync(JsonObject)({ ...document.schema, $defs: document.definitions });
};

/** Read whether an output schema is declared without building one that is computed on demand. */
const declaresOutput = (operation: AppOperation) => {
  if (operation.output !== undefined) return true;
  const property = Object.getOwnPropertyDescriptor(operation, "outputSchema");
  return property !== undefined && (property.get !== undefined || property.value !== undefined);
};
/** The schema an operation is described with: its checked output, else its upstream schema. */
const outputDocument = (operation: AppOperation) =>
  operation.output === undefined ? operation.outputSchema : decoderDocument(operation.output);

/**
 * One operation whose input selects the account whose variant runs. It is a query only when every
 * account's variant is, matching how the merged tool is listed.
 */
const combineOperation = (accounts: ReadonlyMap<string, AppOperation>): AppOperation => {
  const variants = [...accounts.values()];
  const first = variants[0];
  if (first === undefined) throw new Error("An account operation must have at least one account");
  const kind = variants.every((operation) => operation.kind === "query") ? "query" : "mutation";
  const select = (input: Selection) => {
    const operation = accounts.get(input.accountId);
    if (operation === undefined)
      throw new Error("Account selection must be decoded before execution");
    return operation;
  };
  const input = Schema.Union(
    [...accounts].map(([accountId, operation]) =>
      Schema.Struct({ accountId: Schema.Literal(accountId), input: operation.input }),
    ),
  );
  // Combined schemas are built when a tool is described, not on every evaluation for a call.
  const inputSchema = () => ({
    type: "object",
    anyOf: [...accounts].map(([accountId, operation], index) => ({
      type: "object",
      properties: {
        accountId: { type: "string", const: accountId },
        input: nestJsonSchema(
          decoderDocument(operation.input),
          `#/anyOf/${index}/properties/input`,
        ),
      },
      required: ["accountId", "input"],
    })),
  });
  const declaration = operationDeclaration({
    kind,
    ...(first.description === undefined ? {} : { description: first.description }),
    ...(first.title === undefined ? {} : { title: first.title }),
    ...(first.annotations === undefined ||
    !variants.every(
      (operation) => JSON.stringify(operation.annotations) === JSON.stringify(first.annotations),
    )
      ? {}
      : { annotations: first.annotations }),
    ...(first._meta === undefined ||
    !variants.every((operation) => JSON.stringify(operation._meta) === JSON.stringify(first._meta))
      ? {}
      : { _meta: first._meta }),
    input: withLazyJsonSchemaDocument(input, inputSchema),
    approval: (context) => {
      const operation = select(context.toolInput);
      return operation.approval === undefined
        ? Effect.succeed("approved" as const)
        : operation.approval({ ...context, toolInput: context.toolInput.input });
    },
    run: (context, input: Selection) => {
      const operation = select(input);
      return operation.run(context, input.input).pipe(
        Effect.mapError((error) => accountProviderError(error, input.accountId)),
        Effect.flatMap((output) =>
          operation.output === undefined
            ? Effect.succeed(output)
            : Schema.decodeUnknownEffect(operation.output)(output),
        ),
      );
    },
  });
  if (variants.every(declaresOutput)) {
    const outputSchema = once(() => ({
      anyOf: variants
        .flatMap((operation) => {
          const output = outputDocument(operation);
          return output === undefined ? [] : [output];
        })
        .map((output, index) => nestJsonSchema(output, `#/anyOf/${index}`)),
    }));
    const native = nativeOperation(declaration);
    if (native !== undefined)
      Object.defineProperty(native, "outputSchema", { enumerable: true, get: outputSchema });
  }
  const native = nativeOperation(declaration);
  if (native === undefined) throw new Error("Expected a combined operation");
  return native;
};

const sameAcross = <K extends "annotations" | "_meta">(
  key: K,
  variants: readonly (readonly [string, HostedToolSummary & Partial<Pick<HostedTool, "_meta">>])[],
) => {
  const first = variants[0]?.[1][key];
  return first !== undefined &&
    variants.every(([, tool]) => JSON.stringify(tool[key]) === JSON.stringify(first))
    ? { [key]: first }
    : {};
};

/** One entry per name across accounts; schemas stay with the per-tool description. */
const mergeSummary = (
  name: string,
  variants: readonly (readonly [string, HostedToolSummary])[],
) => {
  const first = variants[0]?.[1];
  if (first === undefined) throw new Error("Expected a source operation");
  return Schema.decodeUnknownSync(HostedToolSummary)({
    name,
    description: first.description,
    ...(first.title === undefined ? {} : { title: first.title }),
    readOnly: variants.every(([, tool]) => tool.readOnly === true),
    ...sameAcross("annotations", variants),
  });
};

/** Calls take { accountId, input }, so each account's schema is one branch of the input union. */
const merge = (name: string, variants: readonly (readonly [string, HostedTool])[]) =>
  Schema.decodeUnknownSync(HostedTool)({
    ...mergeSummary(name, variants),
    inputSchema: {
      type: "object",
      anyOf: variants.map(([accountId, tool], index) => ({
        type: "object",
        properties: {
          accountId: { type: "string", const: accountId },
          input: nestJsonSchema(tool.inputSchema, `#/anyOf/${index}/properties/input`),
        },
        required: ["accountId", "input"],
      })),
    },
    ...(variants.every(([, tool]) => tool.outputSchema !== undefined)
      ? {
          outputSchema: {
            anyOf: variants.flatMap(([, tool], index) =>
              tool.outputSchema === undefined
                ? []
                : [nestJsonSchema(tool.outputSchema, `#/anyOf/${index}`)],
            ),
          },
        }
      : {}),
    ...sameAcross("_meta", variants),
  });

/** One dynamic router over every account's source; each tool's variants are merged by name. */
const combineDynamic = (sources: ReadonlyMap<string, DynamicRouter>): DynamicRouter => {
  const first = [...sources.values()][0];
  const grouped = <T extends HostedToolSummary>(
    read: (source: DynamicRouter) => Effect.Effect<readonly T[], unknown>,
  ) =>
    Effect.gen(function* () {
      const groups = new Map<string, [string, T][]>();
      for (const [accountId, source] of sources) {
        const tools = yield* read(source).pipe(
          Effect.mapError((error) => accountProviderError(error, accountId)),
        );
        for (const tool of tools) {
          const variants = groups.get(tool.name) ?? [];
          if (variants.some(([id]) => id === accountId))
            return yield* Effect.die(new Error("Duplicate source operation"));
          variants.push([accountId, tool]);
          groups.set(tool.name, variants);
        }
      }
      return groups;
    });
  return {
    kind: "dynamic",
    // Accounts share one source, so the first account describes the router.
    ...(first?.meta === undefined ? {} : { meta: first.meta }),
    ...(first?.overrides === undefined ? {} : { overrides: first.overrides }),
    list: () =>
      grouped((source) => source.list()).pipe(
        Effect.map((groups) => [...groups].map(([name, variants]) => merge(name, variants))),
      ),
    summaries: () =>
      grouped((source) =>
        source.summaries === undefined ? source.list() : source.summaries(),
      ).pipe(
        Effect.map((groups) => [...groups].map(([name, variants]) => mergeSummary(name, variants))),
      ),
    describe: (name: string) =>
      Effect.gen(function* () {
        const variants: [string, HostedTool][] = [];
        for (const [accountId, source] of sources) {
          const tool = yield* (
            source.describe === undefined
              ? source.list().pipe(Effect.map((tools) => tools.find((tool) => tool.name === name)))
              : source.describe(name)
          ).pipe(Effect.mapError((error) => accountProviderError(error, accountId)));
          if (tool !== undefined) variants.push([accountId, tool]);
        }
        return variants.length === 0 ? undefined : merge(name, variants);
      }),
    resolve: (name: string) =>
      Effect.gen(function* () {
        const operations = new Map<string, AppOperation>();
        for (const [accountId, source] of sources) {
          const operation = yield* source
            .resolve(name)
            .pipe(Effect.mapError((error) => accountProviderError(error, accountId)));
          if (operation !== undefined) operations.set(accountId, operation);
        }
        return operations.size === 0 ? undefined : combineOperation(operations);
      }),
  };
};

/** Merge the same node from each account. Every account's router must have the same shape. */
const combineNode = (variants: ReadonlyMap<string, AppNode>): AppNode => {
  const nodes = [...variants.values()];
  const first = nodes[0];
  if (first === undefined) throw new Error("An account operation must have at least one account");
  switch (first.kind) {
    case "query":
    case "mutation":
      return combineOperation(
        narrow(
          variants,
          (node): node is AppOperation => node.kind === "query" || node.kind === "mutation",
        ),
      );
    case "dynamic":
      return combineDynamic(
        narrow(variants, (node): node is DynamicRouter => node.kind === "dynamic"),
      );
    case "router": {
      const routers = narrow(variants, (node): node is AppRouter => node.kind === "router");
      const keys = new Set([...routers.values()].flatMap((router) => Object.keys(router.children)));
      return {
        kind: "router",
        ...(first.meta === undefined ? {} : { meta: first.meta }),
        children: Object.fromEntries(
          [...keys].map((key) => {
            const children = new Map<string, AppNode>();
            for (const [accountId, router] of routers) {
              const child = Object.hasOwn(router.children, key) ? router.children[key] : undefined;
              if (child !== undefined) children.set(accountId, child);
            }
            return [key, combineNode(children)];
          }),
        ),
      };
    }
  }
};

const narrow = <T extends AppNode>(
  variants: ReadonlyMap<string, AppNode>,
  is: (node: AppNode) => node is T,
): ReadonlyMap<string, T> => {
  const narrowed = new Map<string, T>();
  for (const [accountId, node] of variants) {
    if (!is(node)) throw new Error("Each account's router must have the same shape");
    narrowed.set(accountId, node);
  }
  return narrowed;
};

/**
 * Discover each selected account's router and combine matching names.
 * Calls take { accountId, input }; each branch retains its account's input schema,
 * credentials, approval and output validation. Empty selections expose no operations.
 * Discovery is sequential and cancellation follows the caller's signal. `discover` may return the
 * router or a Promise of it, and the combined router keeps its operations' handler contexts.
 */
export const accountRouter = <
  Account extends { readonly id: string },
  Query = unknown,
  Mutation = unknown,
>(
  accounts: readonly Account[],
  discover: (
    account: Account,
  ) => RouterDeclaration<Query, Mutation> | Promise<RouterDeclaration<Query, Mutation>>,
  options: { readonly signal: AbortSignal },
): Promise<RouterDeclaration<Query, Mutation>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const routers = new Map<string, AppNode>();
      for (const account of accounts) {
        // oxlint-disable-next-line executor/authored-code-through-adapter -- discover is the app's, called from the app's own code
        const declaration = yield* Effect.tryPromise({
          try: async () => discover(account),
          catch: (error) => accountProviderError(error, account.id),
        });
        if (routers.has(account.id))
          return yield* Effect.die(new Error("Account selections must be unique"));
        const router = nativeRouter(declaration);
        if (router === undefined) return yield* Effect.die(new Error("Expected a protocol router"));
        routers.set(account.id, router);
      }
      if (routers.size === 0) return routerDeclaration({ kind: "router", children: {} });
      const combined = combineNode(routers);
      if (combined.kind !== "router" && combined.kind !== "dynamic")
        return yield* Effect.die(new Error("Expected a protocol router"));
      return routerDeclaration(combined);
    }),
    options,
  );
