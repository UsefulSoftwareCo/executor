// Records the cloud free-org limit (3) driven through the REAL createOrganization
// handler + limit logic, with WorkOS + Autumn stubbed in-memory (no network, no PG
// needed — the auth test layers are fully in-memory). Emits a run.json the player
// renders as a chat transcript.
import { it, expect } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  makeCloudAuthApiTestState,
  CloudAuthApiTestContext,
  CloudAuthApiTestContextLayer,
} from "../../apps/cloud/src/auth/cloud-auth-api.test-context";
import { makeWorkOSTestState, makeWorkOSTestMembership } from "../../apps/cloud/src/auth/workos.test-layer";

it.effect("cloud · free plan limits org creation to 3 (recorded)", () => {
  const state = makeCloudAuthApiTestState({ workos: makeWorkOSTestState({ memberships: [] }) });
  const turns: any[] = [
    { role: "user", text: "Create organizations until the free plan stops me" },
    { role: "assistant", kind: "reasoning", text: "Free plan allows 3 orgs. I'll create them one by one and watch the 4th get refused." },
  ];
  return Effect.gen(function* () {
    const { client } = yield* CloudAuthApiTestContext;
    for (let i = 1; i <= 4; i++) {
      const name = `Acme ${i}`;
      const exit = yield* Effect.exit(client.cloudAuth.createOrganization({ payload: { name } }));
      if (Exit.isSuccess(exit)) {
        turns.push({ role: "tool", call: { name: "createOrganization", args: { name } }, ok: true,
          result: exit.value, text: `created "${exit.value.name}" — ${i} of 3 free orgs used` });
        // a successful create adds an active membership → counts toward the limit
        (state.workos.memberships as any).push(makeWorkOSTestMembership(exit.value.id, "active"));
      } else {
        turns.push({ role: "tool", call: { name: "createOrganization", args: { name } }, ok: false,
          result: { error: "free organization limit reached" },
          text: "blocked — free plan is limited to 3 organizations (upgrade to add more)" });
      }
    }
    const created = state.workos.createdOrganizations.length;
    turns.push({ role: "assert", kind: "toBe", actual: created, expected: 3, ok: created === 3 });
    const run = {
      task: "Cloud limits free org creation to 3",
      brain: "scripted", ok: created === 3,
      meta: { server: "cloud (stubbed: WorkOS + Autumn, in-memory)" },
      turns,
    };
    mkdirSync("runs", { recursive: true });
    writeFileSync("runs/cloud-org-limit.run.json", JSON.stringify(run, null, 2));
    expect(created).toBe(3);
  }).pipe(Effect.provide(CloudAuthApiTestContextLayer(state)));
});
