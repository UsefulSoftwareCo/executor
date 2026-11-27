/** The SDK's schedule routes refuse NUL in a name, copy ID, run ID or actor before any lookup. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const source = `import { defineApp, mutation, userInterval, object, router } from "apps";
const send = mutation({ input: object({}) }, async () => ({ done: true }));
export default defineApp({}, async () => ({ tools: router({ send }), schedules: { digest: userInterval({ minutes: 5 }, send, {}) } }));`;

/** A NUL cannot be stored, so a name or ID that carries one is refused before it is looked up. */
const withNul = ["%00", "a%00b"];

layer(TestLive, { excludeTestServices: true })("Local schedule input validation", (it) => {
  it.effect(scenarios.localScheduleInputValidation.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const send = (method: string, path: string, payload?: unknown) =>
          session.send(method, path, payload, headers);
        const deployed = yield* send("POST", "/v1/apps/deploy", {
          owner: "local",
          name: "Schedule validation fixture",
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String }) }),
          deployed,
        );
        yield* Effect.addFinalizer(() => send("DELETE", `/v1/apps/${app.id}`).pipe(Effect.orDie));
        const path = `/v1/apps/${app.id}/schedules`;
        const refused = (label: string, response: { status: number; body: unknown }) =>
          expect(response.status, `${label}: ${JSON.stringify(response.body)}`).toBe(400);

        for (const nul of withNul) {
          // The schedule's name, in the routes that take it.
          refused(
            `configure ${nul}`,
            yield* send("PATCH", `${path}/${nul}`, { actor: "local", enabled: false }),
          );
          refused(`copy ${nul}`, yield* send("GET", `${path}/${nul}/copy?actor=local`));
          // A copy's ID, under a schedule that exists.
          const copy = `${path}/digest/copies/${nul}`;
          refused(`update copy ${nul}`, yield* send("PATCH", copy, { enabled: false }));
          refused(`run copy ${nul}`, yield* send("POST", `${copy}/run`, {}));
          refused(`remove copy ${nul}`, yield* send("DELETE", copy));
          // A run's ID, where its approval is read and answered.
          const approval = `/v1/scheduled-runs/${nul}/approval`;
          refused(`read approval ${nul}`, yield* send("GET", approval));
          refused(`answer approval ${nul}`, yield* send("POST", approval, { action: "decline" }));
        }
        // The actor a request names, in a query and in a payload.
        refused("copy actor", yield* send("GET", `${path}/digest/copy?actor=%00`));
        refused("definitions actor", yield* send("GET", `${path}/definitions?actor=a%00b`));
        refused(
          "configure actor",
          yield* send("PATCH", `${path}/digest`, { actor: "a\u0000b", enabled: false }),
        );

        // Names and IDs without NUL keep their answers: an unknown schedule is not found, and a
        // declared one is configured and read back.
        expect(
          (yield* send("PATCH", `${path}/missing`, {
            actor: "local",
            enabled: true,
            approvalMode: "automatic",
          })).status,
        ).toBe(404);
        const configured = yield* send("PATCH", `${path}/digest`, {
          actor: "local",
          enabled: false,
        });
        expect(configured.status, JSON.stringify(configured.body)).toBe(200);
        const read = yield* send("GET", `${path}/digest/copy?actor=local`);
        expect(read.status, JSON.stringify(read.body)).toBe(200);
      }),
    ),
  );
});
