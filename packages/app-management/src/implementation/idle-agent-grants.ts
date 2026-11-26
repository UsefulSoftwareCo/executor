import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { DataStep, DataStepJournal, DataStepMode } from "../contracts/data-steps.ts";

export interface AgentGrantExpiry<E = unknown> {
  readonly batch: number;
  readonly page: (
    after: string | null,
  ) => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly userId: string }>, E>;
  readonly expire: (
    ids: ReadonlyArray<string>,
    apply: boolean,
  ) => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly outcome: string }>, E>;
  readonly storeModes: (
    ids: ReadonlyArray<string>,
    apply: boolean,
  ) => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly outcome: string }>, E>;
}

export interface AgentGrantHost {
  readonly agentGrants: AgentGrantExpiry;
}

type GrantPage = ReadonlyArray<{ readonly id: string; readonly userId: string }>;

export const eachPage = <G, E, R>(
  grants: AgentGrantExpiry<G>,
  visit: (page: GrantPage) => Effect.Effect<void, E, R>,
): Effect.Effect<void, G | E, R> =>
  grants.page(null).pipe(
    Effect.flatMap(function next(page): Effect.Effect<void, G | E, R> {
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

export const idleAgentGrantsStepName = "4_expire_idle_agent_grants";

const Applied = Schema.Array(Schema.Struct({ completed: Schema.Boolean }));

export const expireIdleAgentGrants = <E>(grants: AgentGrantExpiry<E>, journal: DataStepJournal) =>
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
