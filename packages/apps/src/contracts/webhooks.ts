/** Account-bound webhook lifecycle. Register and unregister must be idempotent for subscriptionId. */
import type { Effect, Schema } from "effect";
import type { ManualWebhookSetup } from "./webhook-protocol.ts";
import type { AccountScope, BoundContext, ScopedSlots } from "./app.ts";

/** What every webhook context provides; a context with `user` serves user-account webhooks. */
type HookContext = Pick<BoundContext<ScopedSlots, AccountScope>, "app" | "fetch" | "signal">;

/**
 * The accounts of the webhook's scope. A context with `user` names a user requirement; one of the
 * `"app"` scope, which has no `user`, an app requirement.
 */
type ScopeAccounts<Context extends HookContext> = Context extends {
  readonly user: { readonly accounts: infer Accounts };
}
  ? Accounts
  : Context["app"]["accounts"];

type SourceAccount<Context extends HookContext> = Context extends { readonly user: unknown }
  ? { readonly user: keyof ScopeAccounts<Context> & string }
  : { readonly app: keyof ScopeAccounts<Context> & string };
type SelectedAccount<Context extends HookContext> = {
  [
    Slot in keyof ScopeAccounts<Context>
  ]: ScopeAccounts<Context>[Slot] extends readonly (infer Account)[]
    ? Account
    : ScopeAccounts<Context>[Slot];
}[keyof ScopeAccounts<Context>];

/**
 * Registration, delivery and cleanup share the selected accounts.
 * The host stores account IDs and parsed state, never credentials.
 * Register runs when enabling a subscription, not on every app evaluation.
 */
interface WebhookLifecycle<
  Context extends HookContext,
  Config extends Schema.Decoder<unknown>,
  State extends Schema.Decoder<unknown>,
  Error = unknown,
> {
  readonly account: SourceAccount<Context>;
  readonly config: Config;
  readonly state: State;
  readonly register: (
    context: Context,
    input: {
      readonly config: Config["Type"];
      readonly subscriptionId: string;
      readonly account: SelectedAccount<Context>;
      readonly callbackUrl: string;
      readonly secret: string;
    },
  ) => Effect.Effect<State["Type"], Error>;
  /** Verify the raw request before acting. */
  readonly handle: (
    context: Context,
    input: {
      readonly request: Request;
      readonly config: Config["Type"];
      readonly subscriptionId: string;
      readonly account: SelectedAccount<Context>;
      readonly callbackUrl: string;
      readonly state: State["Type"] | null;
      readonly secret: string;
    },
  ) => Effect.Effect<Response, Error>;
  /** Remove the upstream registration using its saved state and original account. */
  readonly unregister: (
    context: Context,
    input: {
      readonly state: State["Type"] | null;
      readonly config: Config["Type"];
      readonly subscriptionId: string;
      readonly account: SelectedAccount<Context>;
      readonly callbackUrl: string;
      readonly secret: string;
    },
  ) => Effect.Effect<void, Error>;
}

/** Manual subscriptions collect the state schema in a private browser form instead of invoking provider APIs. */
export type Webhook<
  Context extends HookContext,
  Config extends Schema.Decoder<unknown>,
  State extends Schema.Decoder<unknown>,
  Error = unknown,
> =
  | (WebhookLifecycle<Context, Config, State, Error> & { readonly setup?: never })
  | (Omit<WebhookLifecycle<Context, Config, State, Error>, "register" | "unregister"> & {
      readonly setup: typeof ManualWebhookSetup.Type;
      readonly register?: never;
      readonly unregister?: never;
    });
