import { ManyAccounts } from "../contracts/provider.ts";
/** App author boundary: Promise callbacks are adapted into one native Effect definition. */
import { Effect, Schema as EffectSchema } from "effect";
import { JsonValue } from "../contracts/schema.ts";
import { ScheduleTiming } from "../contracts/schedules.ts";
import type { ScheduleDeclaration } from "./schedules.ts";
import type {
  App as NativeApp,
  AccountScope,
  AccountSlots,
  AppDefinition as NativeDefinition,
  EvaluationContext,
} from "../contracts/app.ts";
import type {
  AppRequirements,
  QueryContext,
  MutationContext,
  RequirementSlots,
  WebhookContext,
} from "../contracts/context.ts";
import { fromPromise, method, type PromiseMethods } from "./authoring.ts";
import { nativeWorkflow, type WorkflowDeclaration } from "./workflows.ts";
import type { WorkflowContext } from "../contracts/workflows.ts";
import { nativeOperation } from "./operations.ts";
import { declaredOperations, nativeRouter, type RouterDeclaration } from "./router.ts";
import { decoderOf, isSchema, type Schema } from "./schema.ts";
import { nativeEvent } from "./events.ts";
import type { AppEvent } from "../contracts/events.ts";
import { appIconsProblem } from "../contracts/icons.ts";

/** One native webhook definition with the given handler context. */
type NativeWebhook<Context> = NonNullable<NativeDefinition<Context>["webhooks"]>[string];

/** A webhook as authors write it: Promise handlers, author schemas and its source requirement. */
type AuthorWebhook<Context, Account> = {
  readonly [Key in keyof NativeWebhook<Context>]: Key extends "config" | "state"
    ? Schema<unknown, boolean>
    : Key extends "account"
      ? Account
      : PromiseMethods<NativeWebhook<Context>>[Key];
};

/**
 * A user-account webhook gets the caller-shaped context; an app-account webhook runs without a
 * caller, so its context has no `user`.
 */
type AuthorWebhooks<Requirements extends AppRequirements> = Readonly<
  Record<
    string,
    | AuthorWebhook<
        WebhookContext<Requirements>,
        { readonly user: keyof RequirementSlots<Requirements>["user"] & string }
      >
    | AuthorWebhook<
        WebhookContext<Requirements, "app">,
        { readonly app: keyof RequirementSlots<Requirements>["app"] & string }
      >
  >
>;

/**
 * User schedules run as each member who enables them; app schedules run without a caller, so their
 * mutation takes a context of the `"app"` scope.
 */
type AuthorSchedules<Requirements extends AppRequirements> = Readonly<
  Record<
    string,
    | ScheduleDeclaration<MutationContext<Requirements>, "user">
    | ScheduleDeclaration<MutationContext<Requirements, "app">, "app">
  >
>;

/**
 * A run started by a caller binds its accounts; one started without a caller, such as by an app
 * schedule, has no `user`, so its workflow declares a context of the `"app"` scope.
 */
type AuthorWorkflows<Requirements extends AppRequirements> = Readonly<
  Record<
    string,
    | WorkflowDeclaration<WorkflowContext<Requirements>>
    | WorkflowDeclaration<WorkflowContext<Requirements, "app">>
  >
>;

/** Author definition projected from native capabilities. Excluding callable objects keeps
 * factories from being inferred as definitions and preserves contextual handler inference. */
export type AppDefinition<Requirements extends AppRequirements> = {
  readonly [Key in keyof NativeDefinition<WebhookContext<Requirements>>]: Key extends "workflows"
    ? AuthorWorkflows<Requirements>
    : Key extends "schedules"
      ? AuthorSchedules<Requirements>
      : Key extends "tools"
        ? RouterDeclaration<QueryContext<Requirements>, MutationContext<Requirements>>
        : Key extends "webhooks"
          ? AuthorWebhooks<Requirements>
          : NativeDefinition<WebhookContext<Requirements>>[Key];
} & {
  readonly name?: never;
  readonly queries?: never;
  readonly mutations?: never;
  readonly call?: never;
};

/** A webhook context as the host builds it: an app-account hook's has no `user`. */
type HostWebhookContext = WebhookContext<AppRequirements, AccountScope> &
  Partial<Pick<WebhookContext, "user">>;

/** Adapt operation and webhook catalogs without evaluating their handlers. */
export type EffectDefinition<Def> = {
  readonly [Key in keyof Def]: Key extends "tools"
    ? NonNullable<NativeDefinition<unknown>["tools"]>
    : Key extends "workflows"
      ? Readonly<Record<string, import("../contracts/workflows.ts").AppWorkflow>>
      : Key extends "schedules"
        ? NonNullable<NativeDefinition<unknown>["schedules"]>
        : Key extends "webhooks"
          ? NonNullable<NativeDefinition<HostWebhookContext>["webhooks"]>
          : Key extends "skills"
            ? NonNullable<NativeDefinition<unknown>["skills"]>
            : Key extends "dynamicSkills"
              ? NonNullable<NativeDefinition<unknown>["dynamicSkills"]>
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
  readonly [InternalApp]: NativeApp<RequirementSlots<Requirements>, EffectDefinition<Def>>;
  readonly accounts: RequirementSlots<Requirements>;
  readonly evaluate: (context: AppFactoryContext<Requirements>) => Promise<Def>;
}

/**
 * What a dynamic definition's factory receives. App-scope work, such as an app schedule, evaluates
 * the app without a caller, so `user` is absent then.
 */
export type AppFactoryContext<Requirements extends AppRequirements> = EvaluationContext<
  RequirementSlots<Requirements>
>;

/** Retrieve the same declaration for an Effect host. No evaluation or I/O occurs. */
export const toEffectApp = <
  Requirements extends AppRequirements,
  Def extends AppDefinition<Requirements>,
>(
  app: App<Requirements, Def>,
): NativeApp<RequirementSlots<Requirements>, EffectDefinition<Def>> => app[InternalApp];

/** Source written before routers (protocols 1 to 3) declares `queries` and `mutations` catalogs. */
function rejectCatalogs(definition: object) {
  if ("queries" in definition || "mutations" in definition)
    throw new Error("Put queries and mutations in a router under tools");
}

function adaptDefinition<
  Requirements extends AppRequirements,
  Def extends AppDefinition<Requirements>,
>(definition: Def): EffectDefinition<Def> {
  rejectCatalogs(definition);
  const webhooks =
    definition.webhooks === undefined
      ? {}
      : {
          // SAFETY: `Required` only where the optional method was just checked to be present.
          webhooks: Object.fromEntries(
            Object.entries(definition.webhooks).map(([name, webhook]) => [
              name,
              {
                ...webhook,
                ...(webhook.register === undefined
                  ? {}
                  : {
                      register: fromPromise(
                        method(webhook as Required<typeof webhook>, "register"),
                        "webhook",
                      ),
                    }),
                handle: fromPromise(method(webhook, "handle"), "webhook"),
                ...(webhook.unregister === undefined
                  ? {}
                  : {
                      unregister: fromPromise(
                        method(webhook as Required<typeof webhook>, "unregister"),
                        "webhook",
                      ),
                    }),
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
  const root = definition.tools === undefined ? undefined : nativeRouter(definition.tools);
  if (definition.tools !== undefined && root === undefined)
    throw new Error("tools must be a router");
  const data = root === undefined ? {} : { tools: root };
  const declared = root?.kind === "router" ? declaredOperations(root) : [];
  // Workflows and schedules name a mutation by its declaration, so each has one path.
  const mutations = new Set<unknown>();
  for (const { operation } of declared) {
    if (operation.kind !== "mutation") continue;
    if (mutations.has(operation))
      throw new Error("A mutation can be mounted at only one path in tools");
    mutations.add(operation);
  }
  const schedules =
    definition.schedules === undefined
      ? {}
      : {
          schedules: Object.fromEntries(
            Object.entries(definition.schedules).map(([name, schedule]) => {
              const target = nativeOperation(schedule.operation);
              const match = declared.find(
                ({ operation }) => operation === target && operation.kind === "mutation",
              );
              if (match === undefined)
                throw new Error("A schedule must reference a mutation in this app's tools");
              if (schedule.scope === "app" && match.operation.approval !== undefined)
                throw new Error("An app schedule must reference a mutation without an approval");
              return [
                name,
                {
                  ...(schedule.scope === "app" ? { scope: "app" as const } : {}),
                  timing: EffectSchema.decodeUnknownSync(ScheduleTiming)(schedule.timing),
                  input: EffectSchema.decodeUnknownSync(JsonValue)(schedule.input),
                  tool: match.name,
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

/**
 * Each scope's requirements, checked once: the removed `accounts` key fails, and a requirement name
 * is used in one scope only, so a host can name a requirement without its scope.
 */
function scopedSlots<Requirements extends AppRequirements>(
  requirements: Requirements,
): RequirementSlots<Requirements> {
  if ("accounts" in requirements)
    throw new TypeError(
      "Declare account requirements by scope: user: { accounts } for each caller's accounts, app: { accounts } for the app's own",
    );
  const app: AccountSlots = requirements.app?.accounts ?? {};
  const user: AccountSlots = requirements.user?.accounts ?? {};
  for (const [name, slot] of Object.entries(app))
    if ("isContributed" in slot && slot.isContributed === true && !(slot instanceof ManyAccounts))
      throw new TypeError(
        `The contributed requirement ${JSON.stringify(name)} must use provider.many().contributed()`,
      );
  for (const [name, slot] of Object.entries(user))
    if (slot instanceof ManyAccounts && slot.isContributed)
      throw new TypeError(
        `The contributed requirement ${JSON.stringify(name)} must be in app.accounts`,
      );
  for (const name of Object.keys(app))
    if (Object.hasOwn(user, name))
      throw new TypeError(
        `The requirement ${JSON.stringify(name)} is declared as both an app and a user account; name them differently`,
      );
  // SAFETY: each scope is the declaration's own slots, or none when the app declares none in it.
  return { app, user } as RequirementSlots<Requirements>;
}

/** Assemble app behavior. Package names belong in package.json; hosts name installed copies. */
export const defineApp = <
  const Requirements extends AppRequirements,
  Def extends AppDefinition<Requirements>,
>(
  requirements: Requirements,
  definition:
    | (Def & AppDefinition<Requirements>)
    | ((context: AppFactoryContext<Requirements>) => Promise<Def & AppDefinition<Requirements>>),
): App<Requirements, Def> => {
  const accounts = scopedSlots(requirements);
  // A static definition is checked when the module loads, so such source fails its build.
  if (typeof definition !== "function") rejectCatalogs(definition);
  const evaluate = typeof definition === "function" ? definition : async () => definition;
  const factory = fromPromise(evaluate, "factory");
  const events =
    requirements.events === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(requirements.events).map(([name, declared]): [string, AppEvent] => {
            const native = nativeEvent(declared);
            if (native === undefined)
              throw new TypeError(
                `The event ${JSON.stringify(name)} must be declared with event()`,
              );
            return [name, native];
          }),
        );
  // Icons are read at build without evaluating the app, so invalid ones fail its build here.
  const iconsProblem =
    requirements.icons === undefined ? undefined : appIconsProblem(requirements.icons);
  if (iconsProblem !== undefined)
    throw new TypeError(`The app's icons are invalid: ${iconsProblem}`);
  const native: NativeApp<RequirementSlots<Requirements>, EffectDefinition<Def>> = {
    accounts,
    ...(events === undefined ? {} : { events }),
    ...(requirements.icons === undefined || requirements.icons.length === 0
      ? {}
      : { icons: requirements.icons }),
    evaluate: (context) =>
      factory(context).pipe(Effect.map((value) => adaptDefinition<Requirements, Def>(value))),
  };
  return {
    [InternalApp]: native,
    accounts: native.accounts,
    evaluate: (context) => Effect.runPromise(factory(context)),
  };
};
