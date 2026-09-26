import type { AppSkillSource, SkillFile } from "./skills.ts";
import type { DatabaseDefinition } from "./storage.ts";
/** Native app contracts; factories and handlers compose in the host's Effect runtime. */
import { type Effect, Schema } from "effect";
import type { OperationSchedule } from "./schedules.ts";
import type { AppOperation } from "./operations.ts";
import type { AccountOf, AuthMethods, ManyAccounts, Provider } from "./provider.ts";
import type { AppWorkflow, WorkflowReads } from "./workflows.ts";
import type { Elicit } from "./elicitation.ts";

/** Composition-only view. Specific handler inputs and outputs stay on the inferred definition. */
type Handler<Context> = (context: Context, input: never) => Effect.Effect<unknown, unknown>;

/** App capabilities share one account context. Package metadata belongs in package.json. */
export interface AppDefinition<Context> {
  /** Optional dynamic tools; resolution does not enumerate the catalog. */
  readonly dynamicTools?: import("./dynamic-tools.ts").DynamicTools;
  /** Omission reads packaged skills/. An explicit catalog replaces that default, including []. */
  readonly skills?: readonly AppSkillSource[];
  /** Optional lazy skills, added to the static catalog. Only skill reads call them. */
  readonly dynamicSkills?: import("./dynamic-skills.ts").DynamicSkills;
  readonly workflows?: Readonly<Record<string, AppWorkflow>>;
  readonly schedules?: Readonly<
    Record<string, Omit<OperationSchedule, "name"> & { readonly tool: string }>
  >;
  readonly queries?: Readonly<Record<string, AppOperation>>;
  readonly mutations?: Readonly<Record<string, AppOperation>>;
  readonly webhooks?: Readonly<
    Record<
      string,
      {
        readonly account: string;
        readonly config: Schema.Decoder<unknown>;
        readonly state: Schema.Decoder<unknown>;
        readonly setup?: import("./webhook-protocol.ts").ManualWebhookSetup;
        readonly register?: Handler<Context>;
        readonly handle: Handler<Context>;
        readonly unregister?: Handler<Context>;
      }
    >
  >;
}

/** Named requirements for one account or a collection from a provider. */
export type AccountSlots = Readonly<
  Record<string, Provider<AuthMethods> | ManyAccounts<AuthMethods>>
>;

type AccountsFor<Slot> =
  Slot extends ManyAccounts<infer Auth> ? readonly AccountOf<Provider<Auth>>[] : AccountOf<Slot>;

/** Current credentials for one invocation. Never retained in source or build output. */
export interface BoundContext<Slots extends AccountSlots> {
  /** Explicit app/build-scoped caching. Account-specific loaders opt into forAccount. */
  readonly cache: import("./cache.ts").AppCache;
  /** Text files retained in this deployment. Paths are package-relative, never host filesystem paths. */
  readonly files: readonly SkillFile[];
  /** Read-only run management, bound to this configured app. */
  readonly workflows: WorkflowReads;
  /** Ask for user input during this tool call. Unavailable during discovery and after the invocation closes. */
  readonly elicit: Elicit;
  /** Invocation-owned HTTP requests with trace propagation and host cancellation. */
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Host cancellation for this invocation. Pass it to fetch and other interruptible APIs. */
  readonly signal: AbortSignal;
  readonly accounts: {
    readonly [Slot in keyof Slots]: AccountsFor<Slots[Slot]>;
  };
}

/** The host evaluates this factory fresh with the configured app's selected accounts. */
export interface App<Slots extends AccountSlots, Def extends AppDefinition<never>> {
  readonly accounts: Slots;
  readonly database?: DatabaseDefinition;
  readonly evaluate: (context: BoundContext<Slots>) => Effect.Effect<Def, unknown>;
}

/** Explicit failure for authored capabilities that are still only sketches. */
export class NotImplemented extends Schema.TaggedError<NotImplemented>()("NotImplemented", {
  operation: Schema.String,
}) {}
