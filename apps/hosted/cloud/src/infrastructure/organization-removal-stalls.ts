import { AlchemyContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer, Schema } from "effect";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import type { OrganizationRemoval } from "./organization-removal-workflow.ts";
import { workflowResultInput } from "./workflow-results.ts";

export const removalStallBindings = Effect.gen(function* () {
  return { ORGANIZATION_REMOVAL_STALLS: (yield* AlchemyContext).dev };
});

type Workflow = Effect.Success<typeof OrganizationRemoval>;
const Present = Schema.Array(Schema.Struct({ present: Schema.Boolean }));

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
        workflowResultInput(options?.params).pipe(
          Effect.flatMap(({ params }) =>
            Schema.decodeUnknownEffect(Schema.Struct({ organization: Schema.String }))(params),
          ),
          Effect.flatMap(({ organization }) => stalled(organization)),
          Effect.flatMap((stall) => (stall ? Effect.never : workflow.create(options))),
          Effect.orDie,
        ),
      get: (instance) => workflow.get(instance),
    };
  });
