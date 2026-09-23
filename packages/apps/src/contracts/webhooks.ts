/** Account-bound webhook lifecycle. Register and unregister must be idempotent for subscriptionId. */
import type { Effect, Schema } from "effect";
import type { ManualWebhookSetup } from "./webhook-protocol.ts";
import type { AccountSlots, BoundContext } from "./app.ts";

type SourceAccount<
  Context extends Pick<BoundContext<AccountSlots>, "accounts" | "fetch" | "signal">,
> = keyof Context["accounts"] & string;
type SelectedAccount<
  Context extends Pick<BoundContext<AccountSlots>, "accounts" | "fetch" | "signal">,
> = {
  [Slot in keyof Context["accounts"]]: Context["accounts"][Slot] extends readonly (infer Account)[]
    ? Account
    : Context["accounts"][Slot];
}[keyof Context["accounts"]];

/**
 * Registration, delivery and cleanup share the selected accounts.
 * The host stores account IDs and parsed state, never credentials.
 * Register runs when enabling a subscription, not on every app evaluation.
 */
interface WebhookLifecycle<
  Context extends Pick<BoundContext<AccountSlots>, "accounts" | "fetch" | "signal">,
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
  Context extends Pick<BoundContext<AccountSlots>, "accounts" | "fetch" | "signal">,
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
