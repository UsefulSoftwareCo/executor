import { accountProviderError } from "./provider-error.ts";
/** Combine account-bound protocol operations without changing their upstream inputs. */
import { Effect, Schema } from "effect";
import type { DynamicTools } from "../contracts/dynamic-tools.ts";
import { HostedTool } from "../contracts/host.ts";
import type { AppOperation, OperationContext } from "../contracts/operations.ts";
import { JsonObject, type JsonValue } from "../contracts/schema.ts";
import { nativeOperation, operationDeclaration, type Operation } from "./operations.ts";
import { importedJsonSchema, nestJsonSchema, once, withLazyJsonSchemaDocument } from "./schema.ts";

type Kind = "query" | "mutation";
type Operations = {
  readonly queries?: Readonly<
    Record<string, Operation<JsonValue, unknown, "query", OperationContext>>
  >;
  readonly dynamicTools?: DynamicTools;
  readonly mutations?: Readonly<
    Record<string, Operation<JsonValue, unknown, "mutation", OperationContext>>
  >;
};
type Selection = { readonly accountId: string; readonly input: unknown };

const inputDocument = (operation: AppOperation) => {
  const imported = importedJsonSchema(operation.input);
  if (imported !== undefined) return Schema.decodeUnknownSync(JsonObject)(imported);
  const document = Schema.toJsonSchemaDocument(operation.input);
  return Schema.decodeUnknownSync(JsonObject)({ ...document.schema, $defs: document.definitions });
};

/** Read whether an output schema is declared without building one that is computed on demand. */
const declaresOutput = (operation: AppOperation) => {
  const property = Object.getOwnPropertyDescriptor(operation, "outputSchema");
  return property !== undefined && (property.get !== undefined || property.value !== undefined);
};

const combine = <K extends Kind>(kind: K, groups: ReadonlyMap<string, Map<string, AppOperation>>) =>
  Object.fromEntries(
    [...groups].map(([name, accounts]) => {
      const variants = [...accounts.values()];
      const first = variants[0];
      if (first === undefined)
        throw new Error("An account operation must have at least one account");
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
            input: nestJsonSchema(inputDocument(operation), `#/anyOf/${index}/properties/input`),
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
          (operation) =>
            JSON.stringify(operation.annotations) === JSON.stringify(first.annotations),
        )
          ? {}
          : { annotations: first.annotations }),
        ...(first._meta === undefined ||
        !variants.every(
          (operation) => JSON.stringify(operation._meta) === JSON.stringify(first._meta),
        )
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
            .flatMap((operation) =>
              operation.outputSchema === undefined ? [] : [operation.outputSchema],
            )
            .map((output, index) => nestJsonSchema(output, `#/anyOf/${index}`)),
        }));
        const native = nativeOperation(declaration);
        if (native !== undefined)
          Object.defineProperty(native, "outputSchema", { enumerable: true, get: outputSchema });
      }
      return [name, declaration];
    }),
  );

/**
 * Discover each selected account's protocol operations and combine matching names.
 * Calls take { accountId, input }; each branch retains its account's input schema,
 * credentials, approval and output validation. Empty selections expose no operations.
 * Discovery is sequential and cancellation follows the caller's signal.
 */
export const accountOperations = <Account extends { readonly id: string }>(
  accounts: readonly Account[],
  discover: (account: Account) => Promise<Operations>,
  options: { readonly signal: AbortSignal },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const queries = new Map<string, Map<string, AppOperation>>();
      const mutations = new Map<string, Map<string, AppOperation>>();
      const sources = new Map<string, DynamicTools>();
      for (const account of accounts) {
        const operations = yield* Effect.tryPromise({
          try: () => discover(account),
          catch: (error) => accountProviderError(error, account.id),
        });
        if (sources.has(account.id))
          return yield* Effect.die(new Error("Account selections must be unique"));
        if (operations.dynamicTools !== undefined) sources.set(account.id, operations.dynamicTools);
        for (const [source, target] of [
          [operations.queries, queries],
          [operations.mutations, mutations],
        ] as const) {
          for (const [name, declaration] of Object.entries(source ?? {})) {
            const operation = nativeOperation(declaration);
            if (operation === undefined)
              return yield* Effect.die(new Error("Expected a protocol operation"));
            const group = target.get(name) ?? new Map<string, AppOperation>();
            if (group.has(account.id))
              return yield* Effect.die(new Error("Account selections must be unique"));
            group.set(account.id, operation);
            target.set(name, group);
          }
        }
      }
      const declared = {
        queries: combine("query", queries),
        mutations: combine("mutation", mutations),
      };
      if (sources.size === 0) return declared;
      return {
        ...declared,
        dynamicTools: {
          list: () =>
            Effect.gen(function* () {
              const groups = new Map<string, Map<string, HostedTool>>();
              for (const [accountId, source] of sources) {
                const tools = yield* source
                  .list()
                  .pipe(Effect.mapError((error) => accountProviderError(error, accountId)));
                for (const tool of tools) {
                  const accounts = groups.get(tool.name) ?? new Map<string, HostedTool>();
                  if (accounts.has(accountId))
                    return yield* Effect.die(new Error("Duplicate source operation"));
                  accounts.set(accountId, tool);
                  groups.set(tool.name, accounts);
                }
              }
              return [...groups].map(([name, accounts]) => {
                const variants = [...accounts];
                const first = variants[0]?.[1];
                if (first === undefined) throw new Error("Expected a source operation");
                return Schema.decodeUnknownSync(HostedTool)({
                  name,
                  description: first.description,
                  ...(first.title === undefined ? {} : { title: first.title }),
                  readOnly: name.startsWith("queries."),
                  inputSchema: {
                    type: "object",
                    anyOf: variants.map(([accountId, tool], index) => ({
                      type: "object",
                      properties: {
                        accountId: { type: "string", const: accountId },
                        input: nestJsonSchema(
                          tool.inputSchema,
                          `#/anyOf/${index}/properties/input`,
                        ),
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
                  ...(first.annotations !== undefined &&
                  variants.every(
                    ([, tool]) =>
                      JSON.stringify(tool.annotations) === JSON.stringify(first.annotations),
                  )
                    ? { annotations: first.annotations }
                    : {}),
                  ...(first._meta !== undefined &&
                  variants.every(
                    ([, tool]) => JSON.stringify(tool._meta) === JSON.stringify(first._meta),
                  )
                    ? { _meta: first._meta }
                    : {}),
                });
              });
            }),
          resolve: (name: string) =>
            Effect.gen(function* () {
              const kind = name.startsWith("queries.") ? "query" : "mutation";
              const operations = new Map<string, AppOperation>();
              for (const [accountId, source] of sources) {
                const operation = yield* source
                  .resolve(name)
                  .pipe(Effect.mapError((error) => accountProviderError(error, accountId)));
                if (operation !== undefined) {
                  if (operation.kind !== kind)
                    return yield* Effect.die(new Error("Operation kind changed"));
                  operations.set(accountId, operation);
                }
              }
              if (operations.size === 0) return undefined;
              return nativeOperation(combine(kind, new Map([[name, operations]]))[name]);
            }),
        } satisfies DynamicTools,
      };
    }),
    options,
  );
