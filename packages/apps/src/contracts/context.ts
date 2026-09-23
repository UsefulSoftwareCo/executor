/** Public handler contexts derive capabilities from one shared requirements declaration. */
import type { WorkflowControls } from "./workflows.ts";
import type { AccountSlots, BoundContext } from "./app.ts";
import type { Database, DatabaseDefinition, DatabaseReader, Tables } from "./storage.ts";

/** Requirements are pure values; selected accounts and database sessions belong to invocations. */
export interface AppRequirements {
  readonly accounts: AccountSlots;
  readonly database?: DatabaseDefinition;
}

type StorageContext<Requirements, Writable extends boolean> = Requirements extends {
  readonly database: DatabaseDefinition<infer T extends Tables>;
}
  ? { readonly db: Writable extends true ? Database<T> : DatabaseReader<T> }
  : {};

/** Context available during dynamic app evaluation; storage opens only for handlers. */
export type AppContext<Requirements extends AppRequirements = AppRequirements> = BoundContext<
  Requirements["accounts"]
>;

/** Interactive query context; declared storage exposes only read methods. */
export type QueryContext<Requirements extends AppRequirements = AppRequirements> =
  AppContext<Requirements> & StorageContext<Requirements, false>;

/** Interactive mutation context; declared storage belongs to the invocation transaction. */
export type MutationContext<Requirements extends AppRequirements = AppRequirements> = Omit<
  AppContext<Requirements>,
  "workflows"
> & { readonly workflows: WorkflowControls } & StorageContext<Requirements, true>;

/** Background webhook context has account and storage access without interactive input. */
export type WebhookContext<Requirements extends AppRequirements = AppRequirements> = Omit<
  MutationContext<Requirements>,
  "elicit"
>;
