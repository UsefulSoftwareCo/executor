/**
 * Store the approval mode on every MCP grant approved before grant records held one. Such a grant
 * serves the mode its consent's resource names (`recordedTarget` in `@executor-js/mcp-auth`);
 * this step writes that mode on the record, so the derivation can be removed once it has applied
 * on every host. A grant whose consent cannot be read stays refused and is not written.
 */
import { Effect } from "effect";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";
import { eachPage, type AgentGrantHost } from "./idle-agent-grants.ts";

/**
 * One item per unrevoked grant. Each is read again when it runs and written only while it still
 * has no mode, so a repeated or resumed pass changes nothing already stored, and a grant approved
 * since the list was read already stores its own.
 */
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

/** The name of the data step above in every host's list. */
export const agentGrantModesStepName = "12_store_agent_grant_modes";
