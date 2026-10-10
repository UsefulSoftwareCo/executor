export { ProviderError } from "./contracts/provider-error.ts";
export { FetchOptionUnsupported, NetworkRefused } from "./contracts/network.ts";
export type { AppCache, CacheLoadContext, CacheGetOptions } from "./contracts/cache.ts";
export { CacheError } from "@executor-js/app-cache/contracts";
/**
 * Public author API. Native contracts live in contracts/; this boundary
 * exposes ordinary declarations, schema helpers and Promise operations.
 */
import { Effect, type Schema as EffectSchema } from "effect";
import type { WebhookContext } from "./contracts/context.ts";
import { type JsonResponse as NativeResponse, ResponseDecodeError } from "./contracts/http.ts";
import {
  OAuth2AccessToken as NativeAccessToken,
  type OAuth2Config as NativeOAuth2Config,
  type OAuth2Method as NativeOAuth2Method,
  type ReservedAuthorizationParam,
  type SecretsMethod as NativeSecretsMethod,
} from "./contracts/provider.ts";
import type { Webhook as NativeWebhook } from "./contracts/webhooks.ts";
import { type PromiseMethods } from "./implementation/authoring.ts";
import { decodeJson as decodeJsonEffect } from "./implementation/http.ts";
import { oauth2 as oauth2Effect, secrets as nativeSecrets } from "./implementation/provider.ts";
import {
  declarePlacements,
  query as queryPlacement,
  type PlacementInput,
  type RequestPlacements,
} from "./implementation/placement.ts";
import type { Placement } from "./contracts/placement.ts";
import type {
  AppContext as NativeAppContext,
  QueryContext as NativeQueryContext,
} from "./contracts/context.ts";
import { query as operationQuery, type OperationOptions } from "./implementation/operations.ts";
import {
  decoderOf,
  fieldExposure,
  isSchema,
  type Fields,
  type Infer,
  type ObjectSchema,
  type Schema,
  type SecretFields,
  type SecretObject,
  wrap,
} from "./implementation/schema.ts";

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && Object.values(value).every(isSchema);

export { type JsonObject, type JsonValue, ValidationError } from "./contracts/schema.ts";
export {
  type Fields,
  type Infer,
  type ObjectSchema,
  type ObjectValue,
  type Schema,
  array,
  boolean,
  json,
  jsonSchema,
  literal,
  number,
  object,
  record,
  string,
  plain,
  raw,
  type SecretString,
} from "./implementation/schema.ts";

export {
  type AccountCheckContext,
  type AccountCheckResult,
  type AccountInfo,
  type AccountOf,
  type AuthMethod,
  type AuthMethodData,
  type AuthMethods,
  type ManyAccounts,
  type Provider,
  type ReservedAuthorizationParam,
} from "./contracts/provider.ts";
export { defineProvider, type ProviderOptions } from "./implementation/provider.ts";
export {
  base64,
  basic,
  bearer,
  header,
  t,
  type FieldRef,
  type FieldRefs,
  type PlacementInput,
  type PlacementValue,
  type RequestPlacements,
} from "./implementation/placement.ts";
export type { Placement };
export type { AccountRequest } from "./contracts/provider.ts";
export { accountRouter } from "./implementation/account-router.ts";
export {
  router,
  dynamicRouter,
  withApprovals,
  type OperationChild,
  type OperationDeclaration,
  type RouterDeclaration,
  type RouterChild,
  type RouterOptions,
} from "./implementation/router.ts";
export type { RouterIcon } from "./contracts/router.ts";
export { dynamicSkills } from "./implementation/dynamic-skills.ts";
export type { HostedTool as OperationDescription } from "./contracts/host.ts";

/** Account fields as app code receives them from a method declared with this schema. */
type AccountFields<S> = S extends ObjectSchema<infer F> ? SecretFields<F> : SecretObject<Infer<S>>;
/** A secrets declaration inferred from an author schema. */
export type SecretsMethod<Shape extends ObjectSchema<Fields>> = NativeSecretsMethod<
  EffectSchema.Decoder<AccountFields<Shape>>
>;
/** An OAuth declaration inferred from its author-facing response schema. */
export type OAuth2Method<Response extends Schema<unknown, boolean>> = NativeOAuth2Method<
  EffectSchema.Decoder<AccountFields<Response>>
>;

/**
 * The native decoder for account fields, typed as app code receives them. `SecretString` is a
 * brand on `string`, so the decoder's values already satisfy it.
 */
const accountDecoder = <S extends Schema<unknown, boolean>>(
  schema: S,
): EffectSchema.Decoder<AccountFields<S>> =>
  // SAFETY: the brand exists only in types; secret values are strings at runtime.
  decoderOf(schema) as unknown as EffectSchema.Decoder<AccountFields<S>>;

/** The `plain()` and `raw()` fields of an object schema, or none. */
const exposureOf = (schema: Schema<unknown, boolean>) => {
  const marked = "fields" in schema && isFields(schema.fields) ? fieldExposure(schema.fields) : {};
  return Object.keys(marked).length === 0 ? {} : { exposure: marked };
};

/** The field names of an object schema; the default OAuth projection has only its access token. */
const fieldNames = (schema: Schema<unknown, boolean>): readonly string[] =>
  "fields" in schema && isFields(schema.fields)
    ? Object.keys(schema.fields)
    : schema === OAuth2AccessToken
      ? ["access_token"]
      : [];

/** A method's placements, declared once from its `request` callback. */
const placementsOf = (
  method: string,
  schema: Schema<unknown, boolean>,
  request: RequestPlacements<string> | undefined,
) =>
  request === undefined
    ? {}
    : {
        request: declarePlacements(
          method,
          fieldNames(schema),
          exposureOf(schema).exposure,
          request,
        ),
      };

/** The names of an object schema's fields, which a method's `request` can reference. */
type FieldNameOf<S> = S extends ObjectSchema<infer F> ? keyof F & string : never;
/** Default OAuth fields visible to app code. Host-only grants and clients stay private. */
export const OAuth2AccessToken = wrap(NativeAccessToken, false);

/**
 * OAuth options as authors write them. `authorizationParams` naming a host-owned protocol
 * parameter such as `state` or `scope` is a type error as well as a declaration failure.
 */
export type OAuth2Config = WithoutReservedParams<NativeOAuth2Config>;
type WithoutReservedParams<Config> = Config extends unknown
  ? "authorizationParams" extends keyof Config
    ? Config & {
        readonly authorizationParams?: { readonly [Key in ReservedAuthorizationParam]?: never };
      }
    : Config
  : never;

/**
 * Declare a secrets method without requiring an Effect schema from the author. `request` says
 * where its secret fields may be sent, such as `({ token }) => bearer(token)`; it runs once, here.
 */
export const secrets = <const F extends Fields>(options: {
  readonly label: string;
  readonly fields: ObjectSchema<F>;
  readonly request?: RequestPlacements<keyof F & string>;
}): SecretsMethod<ObjectSchema<F>> =>
  nativeSecrets({
    label: options.label,
    fields: accountDecoder(options.fields),
    ...exposureOf(options.fields),
    // SAFETY: the callback receives references named by the schema's own keys.
    ...placementsOf(
      `"${options.label}"`,
      options.fields,
      options.request as RequestPlacements<string> | undefined,
    ),
  });

/**
 * Declare OAuth discovery/endpoints and an optional app-visible response projection.
 * `authorizationParams` adds service-defined sign-in parameters; a declared `authorizationUrl`
 * keeps its own query. Neither can set host-owned parameters, and each parameter appears once.
 * `request` says where the projected secret fields may be sent, such as
 * `({ access_token }) => bearer(access_token)`; it runs once, here.
 */
export function oauth2(
  options: OAuth2Config & {
    readonly request?: RequestPlacements<"access_token">;
  },
): OAuth2Method<typeof OAuth2AccessToken>;
export function oauth2<Response extends Schema<unknown, boolean>>(
  options: OAuth2Config & {
    readonly response: Response;
    readonly request?: RequestPlacements<FieldNameOf<Response>>;
  },
): OAuth2Method<Response>;
export function oauth2(
  options: OAuth2Config & {
    readonly response?: Schema<unknown, boolean>;
    readonly request?: unknown;
  },
): OAuth2Method<Schema<unknown, boolean>> {
  const { response = OAuth2AccessToken, request, ...config } = options;
  return Effect.runSync(
    oauth2Effect(
      config,
      accountDecoder(response),
      exposureOf(response).exposure,
      // SAFETY: the callback receives references named by the response projection's own keys.
      placementsOf("OAuth", response, request as RequestPlacements<string> | undefined).request,
    ),
  );
}

export type { AccountSlots } from "./contracts/app.ts";
export type {
  AppRequirements,
  AppContext,
  QueryContext,
  MutationContext,
  WebhookContext,
} from "./contracts/context.ts";
export { type App, type AppDefinition, defineApp } from "./implementation/app.ts";
export { event, type EventDeclaration, type EventEmitter } from "./implementation/events.ts";
export type { EmitOptions } from "./contracts/events.ts";
export type { Approval, ApprovalContext, ApprovalDecision } from "./approval.ts";

type AuthorWebhook<Member, Config, State> = Member extends object
  ? Omit<PromiseMethods<Member>, "config" | "state"> & {
      readonly config: Config;
      readonly state: State;
    }
  : never;
/** Author lifecycle methods use async functions and share native decoded context/state types. */
export type Webhook<
  Context extends WebhookContext,
  Config extends Schema<unknown, boolean>,
  State extends Schema<unknown, boolean>,
> = AuthorWebhook<
  NativeWebhook<Context, EffectSchema.Decoder<Infer<Config>>, EffectSchema.Decoder<Infer<State>>>,
  Config,
  State
>;

export { ResponseDecodeError, ResponseStatusError } from "./contracts/http.ts";
/** Native fetch-compatible response accepted at the author boundary. */
export type JsonResponse = PromiseMethods<NativeResponse>;

/** Decode a fetch response with safe status/body errors. Unexpected reader failures propagate unchanged. */
export const decodeJson = <T>(response: JsonResponse, schema: Schema<T, boolean>): Promise<T> => {
  const native: NativeResponse = {
    status: response.status,
    json: () =>
      // oxlint-disable-next-line executor/authored-code-through-adapter -- a Response the app passes from its own code
      Effect.tryPromise({
        try: () => response.json(),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          error instanceof SyntaxError ? Effect.fail(new ResponseDecodeError()) : Effect.die(error),
        ),
      ),
  };
  return Effect.runPromise(decodeJsonEffect(native, decoderOf(schema)));
};

export { NotImplemented } from "./contracts/app.ts";
export {
  ElicitationFailed,
  type FormElicitation,
  type ElicitationResponse,
  type Elicit,
} from "./contracts/elicitation.ts";

export type {
  Sql,
  SqlCursor,
  SqlReader,
  SqlRow,
  SqlTransaction,
  SqlValue,
} from "./contracts/sql.ts";

/**
 * `query(options, run)` declares a read operation. `query(name, value)` inside a method's
 * `request` places a credential in a query parameter, such as `query("key", key)`.
 */
export function query(name: string, value: PlacementInput): Placement;
export function query<Input, Output, Context extends NativeAppContext = NativeQueryContext>(
  options: OperationOptions<Input, Output>,
  run: (context: Context, input: Input) => Promise<Output>,
): ReturnType<typeof operationQuery<Input, Output, Context>>;
export function query(first: unknown, second: unknown): unknown {
  if (typeof first === "string") return queryPlacement(first, second);
  // SAFETY: the operation overload's signature types both arguments; this only dispatches on `first`.
  return operationQuery(...([first, second] as Parameters<typeof operationQuery>));
}

export {
  mutation,
  withApproval,
  toolAnnotations,
  type Operation,
  type OperationOptions,
} from "./implementation/operations.ts";

export type { OperationContext } from "./contracts/operations.ts";

export { workflow, type Workflow, type WorkflowDeclaration } from "./implementation/workflows.ts";
export {
  NonRetryableError,
  WorkflowFailure,
  type WorkflowContext,
  type WorkflowStepContext,
  type WorkflowStep,
  type WorkflowStepOptions,
  type WorkflowDuration,
  type WorkflowReads,
  type WorkflowControls,
} from "./contracts/workflows.ts";
export { interval, cron, type ScheduleDeclaration } from "./implementation/schedules.ts";

export type { AppSkillSource as Skill, SkillFile } from "./contracts/skills.ts";
