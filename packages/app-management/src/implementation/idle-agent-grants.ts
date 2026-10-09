/**
 * Revoke OAuth grants that cannot be used again and have been idle for 30 days, the refresh token
 * lifetime. The grant plugin in `@executor-js/mcp-auth` decides which grants are idle; this module
 * walks a host's grants through it. A data step applies the rule to existing grants once, so Cloud
 * reports what it would revoke before anything is written. After that step has applied, each host
 * repeats the walk daily for grants that became idle since.
 */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { DataStep, DataStepJournal, DataStepMode } from "../contracts/data-steps.ts";

/** A host's grant expiry endpoints; see `grantExpiry` in `@executor-js/mcp-auth/oauth`. */
export interface AgentGrantExpiry {
  /** The most grants one call lists or checks. */
  readonly batch: number;
  /** Up to `batch` unrevoked grants after `after`, in ID order. */
  readonly page: (
    after: string | null,
  ) => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly userId: string }>, unknown>;
  /** Each grant's outcome; idle grants are revoked only when `apply` is set. */
  readonly expire: (
    ids: ReadonlyArray<string>,
    apply: boolean,
  ) => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly outcome: string }>, unknown>;
}

export interface AgentGrantHost {
  readonly agentGrants: AgentGrantExpiry;
}

type GrantPage = ReadonlyArray<{ readonly id: string; readonly userId: string }>;

/** Visit every unrevoked grant, one page at a time, in ID order. */
const eachPage = <E, R>(
  grants: AgentGrantExpiry,
  visit: (page: GrantPage) => Effect.Effect<void, E, R>,
): Effect.Effect<void, unknown, R> =>
  grants.page(null).pipe(
    Effect.flatMap(function next(page): Effect.Effect<void, unknown, R> {
      const last = page.at(-1);
      if (last === undefined) return Effect.void;
      return visit(page).pipe(
        Effect.andThen(
          page.length < grants.batch
            ? Effect.void
            : grants.page(last.id).pipe(Effect.flatMap(next)),
        ),
      );
    }),
  );

/**
 * The one-off pass over existing grants. Each grant is checked again when it runs, so a grant used
 * since the list was read is kept, and a revoked or missing one is `absent`.
 */
export const idleAgentGrantsStep = (host: AgentGrantHost, name: string): DataStep<never> => ({
  name,
  retry: ["unavailable"],
  items: Effect.gen(function* () {
    const grants: Array<GrantPage[number]> = [];
    yield* eachPage(host.agentGrants, (page) => Effect.sync(() => grants.push(...page)));
    return grants;
  }).pipe(
    Effect.map((grants) =>
      grants.map((grant) => ({
        id: grant.id,
        owner: grant.userId,
        run: (mode: DataStepMode) =>
          host.agentGrants.expire([grant.id], mode === "apply").pipe(
            Effect.map((results) => results[0]?.outcome ?? "absent"),
            Effect.catch(() => Effect.succeed("unavailable")),
          ),
      })),
    ),
  ),
});

/** The name of the data step above in every host's list. */
export const idleAgentGrantsStepName = "4_expire_idle_agent_grants";

const Applied = Schema.Array(Schema.Struct({ completed: Schema.Boolean }));

/**
 * Revoke every grant idle for 30 days, once the data step has applied on this host. Until then,
 * including while Cloud only reports the step, this does nothing, so no grant is revoked without
 * the reviewed step. Logs one summary line with counts per outcome.
 */
export const expireIdleAgentGrants = (grants: AgentGrantExpiry, journal: DataStepJournal) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const applied = yield* sql`select completed_at is not null as completed
      from ${sql(`${journal}_data_steps`)}
      where name = ${idleAgentGrantsStepName} and run = 'apply'`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Applied)),
    );
    if (applied[0]?.completed !== true) return;
    const outcomes: Record<string, number> = {};
    yield* eachPage(grants, (page) =>
      grants
        .expire(
          page.map((grant) => grant.id),
          true,
        )
        .pipe(
          Effect.map((results) => {
            for (const result of results)
              outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
          }),
        ),
    );
    yield* Effect.logInfo("Idle agent grant expiry finished", outcomes);
  }).pipe(Effect.withSpan("job.agent-grants.expire"));
