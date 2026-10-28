/** Public handler contexts derive capabilities from one shared requirements declaration. */
import type { WorkflowControls } from "./workflows.ts";
import type { AccountScope, AccountSlots, BoundContext } from "./app.ts";
import type { Sql, SqlReader } from "./sql.ts";
import type { AnyEventDeclaration, EventEmitter } from "../implementation/events.ts";
import type { AppIcon } from "./icons.ts";

/**
 * Requirements are pure values; bound accounts and SQL access belong to invocations. `app` names the
 * accounts the app's managers link for every caller and for background work, `user` the accounts
 * each caller links. A requirement name is used once across both.
 */
export interface AppRequirements {
  /** All tool effects require an invocation-local private grant (prototype protocol 15). */
  readonly privateInvocation?: true | ReadonlyArray<string>;
  readonly app?: { readonly accounts: AccountSlots };
  readonly user?: { readonly accounts: AccountSlots };
  /** Removed: declare `user: { accounts }` for the caller's accounts or `app: { accounts }`. */
  readonly accounts?: never;
  /** Events this app emits, by name, such as `issue.opened`. */
  readonly events?: Readonly<Record<string, AnyEventDeclaration>>;
  /**
   * Images a dashboard shows for the app, such as its logo in light and dark variants. Each `src`
   * is base64 `data:image/...` or an `https:` URL; at most 8 icons and 32 KiB in total.
   */
  readonly icons?: ReadonlyArray<AppIcon>;
}

/** One scope's requirements; none when the app declares none in it. */
type ScopeSlots<Requirements, Scope extends AccountScope> = Scope extends keyof Requirements
  ? NonNullable<Requirements[Scope]> extends { readonly accounts: infer Slots extends AccountSlots }
    ? Slots
    : Record<never, never>
  : Record<never, never>;

/** An app's requirements by scope, as contexts bind them. */
export type RequirementSlots<Requirements extends AppRequirements> = {
  readonly app: ScopeSlots<Requirements, "app">;
  readonly user: ScopeSlots<Requirements, "user">;
};

/** The emitter for an app's declared events. */
type EventsContext<Requirements extends AppRequirements> = {
  readonly events: EventEmitter<NonNullable<Requirements["events"]>>;
};

/**
 * Every handler has `ctx.sql`. The app's database exists once the build has SQL files in
 * `migrations/`; before that, any statement fails and says so.
 */
type StorageContext<Writable extends boolean> = {
  readonly sql: Writable extends true ? Sql : SqlReader;
};

/**
 * Context available during dynamic app evaluation; storage opens only for handlers. `ctx.app.accounts`
 * holds the app's accounts and `ctx.user.accounts` the caller's. With the `"app"` scope there is no
 * `user`: app schedules and app-account webhooks run without a caller.
 */
export type AppContext<
  Requirements extends AppRequirements = AppRequirements,
  Scope extends AccountScope = "user",
> = BoundContext<RequirementSlots<Requirements>, Scope>;

/** Interactive query context; declared storage exposes only read methods. */
export type QueryContext<
  Requirements extends AppRequirements = AppRequirements,
  Scope extends AccountScope = "user",
> = AppContext<Requirements, Scope> & StorageContext<false>;

/** Interactive mutation context; outside calls happen between SQL transactions, never inside one. */
export type MutationContext<
  Requirements extends AppRequirements = AppRequirements,
  Scope extends AccountScope = "user",
> = Omit<AppContext<Requirements, Scope>, "workflows"> & {
  readonly workflows: WorkflowControls;
} & StorageContext<true> &
  EventsContext<Requirements>;

/**
 * The context of a mutation whose handler declares no parameters. It uses no context, so it may run
 * as the app, such as from an app schedule, where `user` is absent.
 */
export type AnyScopeMutationContext<Requirements extends AppRequirements = AppRequirements> =
  MutationContext<Requirements, "app"> & Partial<Pick<MutationContext<Requirements>, "user">>;

/** Background webhook context has account and storage access without interactive input. */
export type WebhookContext<
  Requirements extends AppRequirements = AppRequirements,
  Scope extends AccountScope = "user",
> = Omit<MutationContext<Requirements, Scope>, "elicit">;
