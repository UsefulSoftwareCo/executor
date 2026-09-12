import { Context, Effect, Ref } from "effect";

/** Workspace-settings authorization bound to the currently executing request. */
export type OrgWriteAccess = "allowed" | "denied";

/**
 * Fiber-local workspace-settings authorization for request-bound executors.
 *
 * The denied default makes a missing request binding fail closed. Non-session
 * executors continue to use their explicit {@link ExecutorConfig.orgWrites}
 * value (or the allowed default) and never consult this reference.
 */
export interface OrgWriteAccessState {
  /** Mutable value inherited by a detached execution and refreshed on resume. */
  readonly current: Ref.Ref<OrgWriteAccess>;
}

/** Create an isolated request/execution authorization state. */
export const makeOrgWriteAccessState = (access: OrgWriteAccess): OrgWriteAccessState => ({
  current: Ref.makeUnsafe(access),
});

/** Request-local workspace-write authorization inherited by child fibers. */
export const CurrentOrgWriteAccess = Context.Reference<OrgWriteAccessState>(
  "@executor-js/sdk/CurrentOrgWriteAccess",
  { defaultValue: () => makeOrgWriteAccessState("denied") },
);

/** Read the effective authorization at a workspace-write sink. */
export const currentOrgWriteAccess: Effect.Effect<OrgWriteAccess> = Effect.gen(function* () {
  const state = yield* CurrentOrgWriteAccess;
  return yield* Ref.get(state.current);
});
