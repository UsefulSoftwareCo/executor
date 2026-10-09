/** Public handler contexts derive capabilities from one shared requirements declaration. */
import type { WorkflowControls } from "./workflows.ts";
import type { AccountSlots, BoundContext } from "./app.ts";
import type { Sql, SqlReader } from "./sql.ts";
import type { AnyEventDeclaration, EventEmitter } from "../implementation/events.ts";

/** Requirements are pure values; selected accounts and SQL access belong to invocations. */
export interface AppRequirements {
  readonly accounts: AccountSlots;
  /** Events this app emits, by name, such as `issue.opened`. */
  readonly events?: Readonly<Record<string, AnyEventDeclaration>>;
}

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

/** Context available during dynamic app evaluation; storage opens only for handlers. */
export type AppContext<Requirements extends AppRequirements = AppRequirements> = BoundContext<
  Requirements["accounts"]
>;

/** Interactive query context; declared storage exposes only read methods. */
export type QueryContext<Requirements extends AppRequirements = AppRequirements> =
  AppContext<Requirements> & StorageContext<false>;

/** Interactive mutation context; outside calls happen between SQL transactions, never inside one. */
export type MutationContext<Requirements extends AppRequirements = AppRequirements> = Omit<
  AppContext<Requirements>,
  "workflows"
> & { readonly workflows: WorkflowControls } & StorageContext<true> &
  EventsContext<Requirements>;

/** Background webhook context has account and storage access without interactive input. */
export type WebhookContext<Requirements extends AppRequirements = AppRequirements> = Omit<
  MutationContext<Requirements>,
  "elicit"
>;
