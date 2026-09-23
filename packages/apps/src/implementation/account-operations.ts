import { accountProviderError } from "./provider-error.ts";
/** Combine account-bound protocol operations without changing their upstream inputs. */
import { Effect, Schema } from "effect";
import type { AppOperation, OperationContext } from "../contracts/operations.ts";
import { JsonObject, type JsonValue } from "../contracts/schema.ts";
import { nativeOperation, operationDeclaration, type Operation } from "./operations.ts";
import { importedJsonSchema, nestJsonSchema, withJsonSchemaDocument } from "./schema.ts";

type Kind = "query" | "mutation";
type Operations = {
  readonly queries: Readonly<
    Record<string, Operation<JsonValue, unknown, "query", OperationContext>>
  >;
  readonly mutations: Readonly<
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
      const outputs = variants.flatMap((operation) =>
        operation.outputSchema === undefined ? [] : [operation.outputSchema],
      );
      const input = Schema.Union(
        [...accounts].map(([accountId, operation]) =>
          Schema.Struct({ accountId: Schema.Literal(accountId), input: operation.input }),
        ),
      );
      const inputSchema = {
        type: "object",
        anyOf: [...accounts].map(([accountId, operation], index) => ({
          type: "object",
          properties: {
            accountId: { type: "string", const: accountId },
            input: nestJsonSchema(inputDocument(operation), `#/anyOf/${index}/properties/input`),
          },
          required: ["accountId", "input"],
        })),
      };
      return [
        name,
        operationDeclaration({
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
          input: withJsonSchemaDocument(input, inputSchema),
          ...(outputs.length !== variants.length
            ? {}
            : {
                outputSchema: {
                  anyOf: outputs.map((output, index) => nestJsonSchema(output, `#/anyOf/${index}`)),
                },
              }),
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
        }),
      ];
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
      for (const account of accounts) {
        const operations = yield* Effect.tryPromise({
          try: () => discover(account),
          catch: (error) => accountProviderError(error, account.id),
        });
        for (const [source, target] of [
          [operations.queries, queries],
          [operations.mutations, mutations],
        ] as const) {
          for (const [name, declaration] of Object.entries(source)) {
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
      return { queries: combine("query", queries), mutations: combine("mutation", mutations) };
    }),
    options,
  );
