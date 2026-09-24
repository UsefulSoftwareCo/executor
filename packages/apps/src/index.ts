export { ProviderError } from "./contracts/provider-error.ts";
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
  type OAuth2Config,
  type OAuth2Method as NativeOAuth2Method,
  type SecretsMethod as NativeSecretsMethod,
} from "./contracts/provider.ts";
import type { Webhook as NativeWebhook } from "./contracts/webhooks.ts";
import { type PromiseMethods } from "./implementation/authoring.ts";
import { decodeJson as decodeJsonEffect } from "./implementation/http.ts";
import { oauth2 as oauth2Effect, secrets as nativeSecrets } from "./implementation/provider.ts";
import {
  decoderOf,
  type Fields,
  type Infer,
  type ObjectSchema,
  type Schema,
  wrap,
} from "./implementation/schema.ts";

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
} from "./implementation/schema.ts";

export {
  type AccountOf,
  type AuthMethod,
  type AuthMethodData,
  type AuthMethods,
  type ManyAccounts,
  type OAuth2Config,
  type Provider,
} from "./contracts/provider.ts";
export { defineProvider } from "./implementation/provider.ts";
export { accountOperations } from "./implementation/account-operations.ts";
export { dynamicTools } from "./implementation/dynamic-tools.ts";
export type { HostedTool as OperationDescription } from "./contracts/host.ts";

/** A secrets declaration inferred from an author schema. */
export type SecretsMethod<Shape extends ObjectSchema<Fields>> = NativeSecretsMethod<
  EffectSchema.Decoder<Infer<Shape>>
>;
/** An OAuth declaration inferred from its author-facing response schema. */
export type OAuth2Method<Response extends Schema<unknown, boolean>> = NativeOAuth2Method<
  EffectSchema.Decoder<Infer<Response>>
>;
/** Default OAuth fields visible to app code. Host-only grants and clients stay private. */
export const OAuth2AccessToken = wrap(NativeAccessToken, false);

/** Declare a secrets method without requiring an Effect schema from the author. */
export const secrets = <const F extends Fields>(options: {
  readonly label: string;
  readonly fields: ObjectSchema<F>;
}): SecretsMethod<ObjectSchema<F>> =>
  nativeSecrets({ label: options.label, fields: decoderOf(options.fields) });

/** Declare OAuth discovery/endpoints and an optional app-visible response projection. */
export function oauth2(options: OAuth2Config): OAuth2Method<typeof OAuth2AccessToken>;
export function oauth2<Response extends Schema<unknown, boolean>>(
  options: OAuth2Config & {
    readonly response: Response;
  },
): OAuth2Method<Response>;
export function oauth2(
  options: OAuth2Config & {
    readonly response?: Schema<unknown, boolean>;
  },
): OAuth2Method<Schema<unknown, boolean>> {
  const { response = OAuth2AccessToken, ...config } = options;
  return Effect.runSync(oauth2Effect(config, decoderOf(response)));
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

export {
  table,
  defineDatabase,
  type Table,
  type DatabaseReader,
  type Database,
  type DatabaseDefinition,
} from "./implementation/storage.ts";

export { id, userId } from "./implementation/schema.ts";

export {
  query,
  mutation,
  withApproval,
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
