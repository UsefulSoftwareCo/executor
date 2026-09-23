/** App author boundary: Promise callbacks are adapted into one native Effect definition. */
import { Effect, Schema as EffectSchema } from "effect";
import { JsonValue } from "../contracts/schema.ts";
import { ScheduleTiming } from "../contracts/schedules.ts";
import type { ScheduleDeclaration } from "./schedules.ts";
import type { App as NativeApp, AppDefinition as NativeDefinition } from "../contracts/app.ts";
import type {
  AppRequirements,
  AppContext,
  QueryContext,
  MutationContext,
  WebhookContext,
} from "../contracts/context.ts";
import { fromPromise, type PromiseMethods } from "./authoring.ts";
import { nativeWorkflow, type WorkflowDeclaration } from "./workflows.ts";
import type { WorkflowContext } from "../contracts/workflows.ts";
import { nativeOperation, type OperationDeclaration } from "./operations.ts";
import { decoderOf, isSchema, type Schema } from "./schema.ts";

type PromiseCatalog<Catalog> =
  Catalog extends Readonly<Record<string, object>>
    ? {
        readonly [Name in keyof Catalog]: {
          readonly [Key in keyof Catalog[Name]]: Key extends "config" | "state"
            ? Schema<unknown, boolean>
            : PromiseMethods<Catalog[Name]>[Key];
        };
      }
    : Catalog;

/** Author definition projected from native capabilities. Excluding callable objects keeps
 * factories from being inferred as definitions and preserves contextual handler inference. */
export type AppDefinition<Requirements extends AppRequirements> = {
  readonly [Key in keyof NativeDefinition<WebhookContext<Requirements>>]: Key extends "workflows"
    ? Readonly<Record<string, WorkflowDeclaration<WorkflowContext<Requirements>>>>
    : Key extends "schedules"
      ? Readonly<Record<string, ScheduleDeclaration<MutationContext<Requirements>>>>
      : Key extends "queries"
        ? Readonly<Record<string, OperationDeclaration<"query", QueryContext<Requirements>>>>
        : Key extends "mutations"
          ? Readonly<
              Record<string, OperationDeclaration<"mutation", MutationContext<Requirements>>>
            >
          : Key extends "webhooks"
            ? PromiseCatalog<NonNullable<NativeDefinition<WebhookContext<Requirements>>[Key]>>
            : NativeDefinition<WebhookContext<Requirements>>[Key];
} & { readonly name?: never; readonly tools?: never; readonly call?: never };

/** Adapt operation and webhook catalogs without evaluating their handlers. */
export type EffectDefinition<Def> = {
  readonly [Key in keyof Def]: Key extends "workflows"
    ? Readonly<Record<string, import("../contracts/workflows.ts").AppWorkflow>>
    : Key extends "schedules"
      ? NonNullable<NativeDefinition<unknown>["schedules"]>
      : Key extends "queries" | "mutations"
        ? Readonly<Record<string, import("../contracts/operations.ts").AppOperation>>
        : Key extends "webhooks"
          ? NonNullable<NativeDefinition<WebhookContext>["webhooks"]>
          : Def[Key];
};

const InternalApp = Symbol("apps.App");

/** Recognize a declaration from this framework instance before host adaptation. */
export const isApp = (
  value: unknown,
): value is App<AppRequirements, AppDefinition<AppRequirements>> =>
  typeof value === "object" && value !== null && InternalApp in value;

/** Public app handle; the native app is retained for host use without an async round trip. */
export interface App<
  Requirements extends AppRequirements,
  Def extends AppDefinition<Requirements>,
> {
  readonly [InternalApp]: NativeApp<Requirements["accounts"], EffectDefinition<Def>>;
  readonly accounts: Requirements["accounts"];
  readonly evaluate: (context: AppContext<Requirements>) => Promise<Def>;
}

/** Retrieve the same declaration for an Effect host. No evaluation or I/O occurs. */
export const toEffectApp = <
  Requirements extends AppRequirements,
  Def extends AppDefinition<Requirements>,
>(
  app: App<Requirements, Def>,
): NativeApp<Requirements["accounts"], EffectDefinition<Def>> => app[InternalApp];

function adaptDefinition<
  Requirements extends AppRequirements,
  Def extends AppDefinition<Requirements>,
>(definition: Def): EffectDefinition<Def> {
  if ("tools" in definition) throw new Error("Use queries and mutations instead of tools");
  const webhooks =
    definition.webhooks === undefined
      ? {}
      : {
          webhooks: Object.fromEntries(
            Object.entries(definition.webhooks).map(([name, webhook]) => [
              name,
              {
                ...webhook,
                ...(webhook.register === undefined
                  ? {}
                  : { register: fromPromise(webhook.register) }),
                handle: fromPromise(webhook.handle),
                ...(webhook.unregister === undefined
                  ? {}
                  : { unregister: fromPromise(webhook.unregister) }),
                ...("config" in webhook && isSchema(webhook.config)
                  ? { config: decoderOf(webhook.config) }
                  : {}),
                ...("state" in webhook && isSchema(webhook.state)
                  ? { state: decoderOf(webhook.state) }
                  : {}),
              },
            ]),
          ),
        };
  const operations = (kind: "query" | "mutation", catalog: Readonly<Record<string, unknown>>) =>
    Object.fromEntries(
      Object.entries(catalog).map(([name, value]) => {
        const operation = nativeOperation(value);
        if (operation === undefined || operation.kind !== kind)
          throw new Error("Invalid app data operation");
        return [name, operation];
      }),
    );
  const workflows =
    definition.workflows === undefined
      ? {}
      : {
          workflows: Object.fromEntries(
            Object.entries(definition.workflows).map(([name, value]) => {
              const declared = nativeWorkflow(value);
              if (declared === undefined) throw new Error("Invalid workflow declaration");
              return [name, declared];
            }),
          ),
        };
  const data = {
    ...(definition.queries === undefined
      ? {}
      : { queries: operations("query", definition.queries) }),
    ...(definition.mutations === undefined
      ? {}
      : { mutations: operations("mutation", definition.mutations) }),
  };
  const schedules =
    definition.schedules === undefined
      ? {}
      : {
          schedules: Object.fromEntries(
            Object.entries(definition.schedules).map(([name, schedule]) => {
              const matches = Object.entries(definition.mutations ?? {}).filter(
                ([, operation]) => operation === schedule.operation,
              );
              const match = matches[0];
              if (match === undefined || matches.length !== 1)
                throw new Error("A schedule must reference exactly one named mutation in this app");
              return [
                name,
                {
                  timing: EffectSchema.decodeUnknownSync(ScheduleTiming)(schedule.timing),
                  input: EffectSchema.decodeUnknownSync(JsonValue)(schedule.input),
                  tool: `mutations.${match[0]}`,
                },
              ];
            }),
          ),
        };
  // SAFETY: only the listed handler/schema fields are replaced. Each callback
  // forwards the same arguments/result; every other property and catalog key survives.
  // Object.entries/fromEntries erase those generic key associations.
  return {
    ...definition,
    ...webhooks,
    ...workflows,
    ...data,
    ...schedules,
  } as EffectDefinition<Def>;
}

/** Assemble app behavior. Package names belong in package.json; hosts name installed copies. */
export const defineApp = <
  const Requirements extends AppRequirements,
  Def extends AppDefinition<Requirements>,
>(
  requirements: Requirements,
  definition:
    | (Def & AppDefinition<Requirements>)
    | ((context: AppContext<Requirements>) => Promise<Def & AppDefinition<Requirements>>),
): App<Requirements, Def> => {
  const evaluate = typeof definition === "function" ? definition : async () => definition;
  const factory = fromPromise(evaluate);
  const native: NativeApp<Requirements["accounts"], EffectDefinition<Def>> = {
    accounts: requirements.accounts,
    ...(requirements.database === undefined ? {} : { database: requirements.database }),
    evaluate: (context) =>
      factory(context).pipe(Effect.map((value) => adaptDefinition<Requirements, Def>(value))),
  };
  return {
    [InternalApp]: native,
    accounts: native.accounts,
    evaluate: (context) => Effect.runPromise(factory(context)),
  };
};
