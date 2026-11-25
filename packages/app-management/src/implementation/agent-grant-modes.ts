import { Effect } from "effect";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";
import { eachPage, type AgentGrantHost } from "./idle-agent-grants.ts";

export const agentGrantModesStep = (host: AgentGrantHost, name: string): DataStep<never> => ({
  name,
  retry: ["unavailable"],
  items: Effect.gen(function* () {
    const grants: Array<{ readonly id: string; readonly userId: string }> = [];
    yield* eachPage(host.agentGrants, (page) => Effect.sync(() => grants.push(...page)));
    return grants;
  }).pipe(
    Effect.map((grants) =>
      grants.map((grant) => ({
        id: grant.id,
        owner: grant.userId,
        run: (mode: DataStepMode) =>
          host.agentGrants.storeModes([grant.id], mode === "apply").pipe(
            Effect.map((results) => results[0]?.outcome ?? "absent"),
            Effect.catch(() => Effect.succeed("unavailable")),
          ),
      })),
    ),
  ),
});

export const agentGrantModesStepName = "12_store_agent_grant_modes";
