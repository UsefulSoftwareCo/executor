/**
 * Local test hook: Workflows `create` stalls for a chosen organization, as Cloudflare's does for
 * about one instance in a few hundred, so a scenario can prove the recovery path on cue. Local
 * Workflows never stalls by itself. Only `alchemy dev` installs the hook: its binding is
 * `AlchemyContext.dev`, so a deployed Worker gets `false` and calls the binding directly.
 *
 * A scenario creates `e2e_organization_removal_stall` and adds a row per organization. A create
 * for that organization then answers nothing while the row's `stalled_until` is in the future;
 * the caller's own deadline ends it. Status reads are not stalled: the instance does not exist,
 * so they answer "not found", as they did after the stalled creates Cloudflare refused.
 */
import { AlchemyContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer, Schema } from "effect";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import type { OrganizationRemoval } from "./organization-removal-workflow.ts";

/** Worker props for the API Worker; true only under `alchemy dev`. */
export const removalStallBindings = Effect.gen(function* () {
  return { ORGANIZATION_REMOVAL_STALLS: (yield* AlchemyContext).dev };
});

type Workflow = Effect.Success<typeof OrganizationRemoval>;
const Present = Schema.Array(Schema.Struct({ present: Schema.Boolean }));

/** The binding as removal starts use it, with the local stall in front of `create`. */
export const localRemovalStalls = <E>(
  workflow: Workflow,
  database: Layer.Layer<GroupDatabase, E>,
): Effect.Effect<Pick<Workflow, "create" | "get">, never, Cloudflare.WorkerEnvironment> =>
  Effect.gen(function* () {
    const environment = yield* Cloudflare.WorkerEnvironment;
    if (environment.ORGANIZATION_REMOVAL_STALLS !== true) return workflow;
    const stalled = (organization: string) =>
      Effect.gen(function* () {
        const sql = yield* Effect.flatten(GroupDatabase);
        const [table] = yield* sql`select to_regclass('e2e_organization_removal_stall') is not null
          as present`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Present)));
        if (table?.present !== true) return false;
        const rows = yield* sql`select 1 from e2e_organization_removal_stall
          where organization_id = ${organization} and stalled_until > now()`;
        return rows.length > 0;
      }).pipe(Effect.provide(database), Effect.scoped, Effect.orDie);
    return {
      create: (options) =>
        stalled(options?.params?.organization ?? "").pipe(
          Effect.flatMap((stall) => (stall ? Effect.never : workflow.create(options))),
        ),
      get: (instance) => workflow.get(instance),
    };
  });
