import { accountProviderError } from "./provider-error.ts";
/** Combine account-bound protocol operations without changing their upstream inputs. */
import { Effect, Result, Schema } from "effect";
import { HostedTool, HostedToolSummary } from "../contracts/host.ts";
import type { AppOperation } from "../contracts/operations.ts";
import type { AppNode, AppRouter, DynamicRouter } from "../contracts/router.ts";
import { JsonObject } from "../contracts/schema.ts";
import { nativeOperation, operationDeclaration } from "./operations.ts";
import { nativeRouter, routerDeclaration, type RouterDeclaration } from "./router.ts";
import {
  combineJsonSchemas,
  importedJsonSchema,
  once,
  withLazyJsonSchemaDocument,
} from "./schema.ts";

type Selection = { readonly accountId: string; readonly input: unknown };

/**
 * Some accounts listed their tools and at least one could not: the tools the others listed, and
 * the first failing account's error. A catalog read keeps the tools and reports the error on the
 * router, so one broken account does not hide every other account's tools.
 */
export class PartialListing extends Schema.TaggedError<PartialListing>()("PartialListing", {
  tools: Schema.Array(Schema.Unknown),
  error: Schema.Unknown,
}) {}

const decoderDocument = (decoder: Schema.Decoder<unknown>) => {
  const imported = importedJsonSchema(decoder);
  if (imported !== undefined) return Schema.decodeUnknownSync(JsonObject)(imported);
  const document = Schema.toJsonSchemaDocument(decoder);
  return Schema.decodeUnknownSync(JsonObject)({ ...document.schema, $defs: document.definitions });
};

/**
 * Accounts of one source usually describe the same schema. Those accounts share one branch, so a
 * tool's schemas grow with its distinct schemas rather than with its accounts: a large API linked
 * through many accounts would otherwise be described once per account. Branch definitions stay in
 * the root `$defs`, where a listing shares them among its tools.
 */
const accountBranches = (variants: readonly (readonly [string, JsonObject])[]) => {
  const groups = new Map<string, { schema: JsonObject; first: string; rest: string[] }>();
  for (const [accountId, schema] of variants) {
    const key = JSON.stringify(schema);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { schema, first: accountId, rest: [] });
    else group.rest.push(accountId);
  }
  const branches = [...groups.values()];
  const { $defs, schemas } = combineJsonSchemas(
    branches.map(({ schema }) => schema),
    (index) => `#/anyOf/${index}/properties/input`,
  );
  return {
    type: "object",
    ...($defs === undefined ? {} : { $defs }),
    anyOf: schemas.map((input, index) => {
      const { first, rest } = branches[index]!;
      return {
        type: "object",
        properties: {
          accountId:
            rest.length === 0
              ? { type: "string", const: first }
              : { type: "string", enum: [first, ...rest] },
          input,
        },
        required: ["accountId", "input"],
      };
    }),
  };
};

/** Each distinct output schema once: a value matches the union whichever account returned it. */
const outputBranches = (outputs: readonly JsonObject[]) => {
  const { $defs, schemas } = combineJsonSchemas(
    [...new Map(outputs.map((output) => [JSON.stringify(output), output])).values()],
    (index) => `#/anyOf/${index}`,
  );
  return { ...($defs === undefined ? {} : { $defs }), anyOf: schemas };
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
 * account's variant is, matching how the merged tool is listed. An account in `failed` could not
 * resolve the tool: selecting it fails with that account's error before anything runs, rather than
 * as input naming an unknown account. It is not described and does not decide the kind.
 */
const combineOperation = (
  accounts: ReadonlyMap<string, AppOperation>,
  failed: ReadonlyMap<string, unknown> = new Map(),
): AppOperation => {
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
  const input = Schema.Union([
    ...[...accounts].map(([accountId, operation]) =>
      Schema.Struct({ accountId: Schema.Literal(accountId), input: operation.input }),
    ),
    ...[...failed.keys()].map((accountId) =>
      Schema.Struct({ accountId: Schema.Literal(accountId), input: Schema.Unknown }),
    ),
  ]);
  // Combined schemas are built when a tool is described, not on every evaluation for a call.
  const inputSchema = () =>
    accountBranches(
      [...accounts].map(([accountId, operation]) => [accountId, decoderDocument(operation.input)]),
    );
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
      // A failed account's call fails before it reaches the service, so it has nothing to approve.
      if (failed.has(context.toolInput.accountId)) return Effect.succeed("approved" as const);
      const operation = select(context.toolInput);
      return operation.approval === undefined
        ? Effect.succeed("approved" as const)
        : operation.approval({ ...context, toolInput: context.toolInput.input });
    },
    run: (context, input: Selection) => {
      if (failed.has(input.accountId))
        return Effect.fail(accountProviderError(failed.get(input.accountId), input.accountId));
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
    const outputSchema = once(() =>
      outputBranches(
        variants.flatMap((operation) => {
          const output = outputDocument(operation);
          return output === undefined ? [] : [output];
        }),
      ),
    );
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
    ...(variants.every(([, tool]) => tool.kindConfirmed === true) ? { kindConfirmed: true } : {}),
    ...sameAcross("annotations", variants),
  });
};

/** Calls take { accountId, input }, so each distinct account schema is one branch of the union. */
const merge = (name: string, variants: readonly (readonly [string, HostedTool])[]) =>
  Schema.decodeUnknownSync(HostedTool)({
    ...mergeSummary(name, variants),
    inputSchema: accountBranches(
      variants.map(([accountId, tool]) => [accountId, tool.inputSchema]),
    ),
    ...(variants.every(([, tool]) => tool.outputSchema !== undefined)
      ? {
          outputSchema: outputBranches(
            variants.flatMap(([, tool]) =>
              tool.outputSchema === undefined ? [] : [tool.outputSchema],
            ),
          ),
        }
      : {}),
    ...sameAcross("_meta", variants),
  });

/** Accounts whose sources are read at once. Each read may reach its account's upstream service. */
const accountConcurrency = 8;

/**
 * Read every account's source, each on its own: one account's failure does not stop the others.
 * Reads run together; values and failures are kept in account order, each failure attributed to
 * its account.
 */
const eachAccount = <A>(
  sources: ReadonlyMap<string, DynamicRouter>,
  read: (source: DynamicRouter) => Effect.Effect<A, unknown>,
) =>
  Effect.gen(function* () {
    const results = yield* Effect.forEach(
      sources,
      ([accountId, source]) =>
        Effect.result(
          read(source).pipe(Effect.mapError((error) => accountProviderError(error, accountId))),
        ).pipe(Effect.map((result) => [accountId, result] as const)),
      { concurrency: accountConcurrency },
    );
    const values = new Map<string, A>();
    const failed = new Map<string, unknown>();
    for (const [accountId, result] of results)
      if (Result.isSuccess(result)) values.set(accountId, result.success);
      else failed.set(accountId, result.failure);
    return { values, failed };
  });

/** The first account's failure. A source no account could read fails with it, as one account would. */
const firstFailure = (failed: ReadonlyMap<string, unknown>) => [...failed.values()][0];

/** One dynamic router over every account's source; each tool's variants are merged by name. */
const combineDynamic = (sources: ReadonlyMap<string, DynamicRouter>): DynamicRouter => {
  const first = [...sources.values()][0];
  /**
   * Every account's tools grouped by name. When some accounts fail and others list, it fails with
   * `PartialListing`, which carries the others' tools; when every account fails, with the first
   * account's error.
   */
  const grouped = <T extends HostedToolSummary, R>(
    read: (source: DynamicRouter) => Effect.Effect<readonly T[], unknown>,
    merged: (name: string, variants: readonly (readonly [string, T])[]) => R,
  ) =>
    Effect.gen(function* () {
      const { values: listed, failed } = yield* eachAccount(sources, read);
      if (listed.size === 0 && failed.size > 0) return yield* Effect.fail(firstFailure(failed));
      const groups = new Map<string, [string, T][]>();
      for (const [accountId, tools] of listed)
        for (const tool of tools) {
          const variants = groups.get(tool.name) ?? [];
          if (variants.some(([id]) => id === accountId))
            return yield* Effect.die(new Error("Duplicate source operation"));
          variants.push([accountId, tool]);
          groups.set(tool.name, variants);
        }
      const tools = [...groups].map(([name, variants]) => merged(name, variants));
      if (failed.size === 0) return tools;
      return yield* new PartialListing({ tools, error: firstFailure(failed) });
    });
  return {
    kind: "dynamic",
    // Accounts share one source, so the first account that can describe it describes the router.
    ...(first?.meta === undefined
      ? {}
      : {
          meta: () =>
            Effect.gen(function* () {
              const failures: unknown[] = [];
              for (const source of sources.values()) {
                if (source.meta === undefined) continue;
                const result = yield* Effect.result(source.meta());
                if (Result.isSuccess(result)) return result.success;
                failures.push(result.failure);
              }
              return yield* Effect.fail(failures[0]);
            }),
        }),
    ...(first?.overrides === undefined ? {} : { overrides: first.overrides }),
    list: () => grouped((source) => source.list(), merge),
    summaries: () =>
      grouped(
        (source) => (source.summaries === undefined ? source.list() : source.summaries()),
        mergeSummary,
      ),
    describe: (name: string) =>
      eachAccount(sources, (source) =>
        source.describe === undefined
          ? source.list().pipe(Effect.map((tools) => tools.find((tool) => tool.name === name)))
          : source.describe(name),
      ).pipe(
        Effect.flatMap(({ values, failed }) => {
          const variants = [...values].flatMap(([accountId, tool]) =>
            tool === undefined ? [] : [[accountId, tool] as const],
          );
          // No account that answered has it; it may be a failed account's.
          if (variants.length === 0)
            return failed.size > 0 ? Effect.fail(firstFailure(failed)) : Effect.succeed(undefined);
          return Effect.succeed(merge(name, variants));
        }),
      ),
    resolve: (name: string) =>
      eachAccount(sources, (source) => source.resolve(name)).pipe(
        Effect.flatMap(({ values, failed }) => {
          const operations = new Map(
            [...values].flatMap(([accountId, operation]) =>
              operation === undefined ? [] : [[accountId, operation] as const],
            ),
          );
          if (operations.size === 0)
            return failed.size > 0 ? Effect.fail(firstFailure(failed)) : Effect.succeed(undefined);
          return Effect.succeed(combineOperation(operations, failed));
        }),
      ),
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
 * An account whose source fails does not hide the others' tools; its error is reported on the
 * router, and a call that selects it fails with that error.
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
