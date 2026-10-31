/** The local bearer API can observe work; only a paired browser answers the human question. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Redacted, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { workflowInputFiles } from "../support/workflow-input-app.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Local durable input", (it) => {
  it.effect(scenarios.localWorkflowInput.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target;
        const agent = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const deployed = yield* agent.send(
          "POST",
          "/v1/apps/deploy",
          { owner: "local", name: "Local durable input", files: workflowInputFiles },
          headers,
        );
        expect(deployed.status).toBe(200);
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String }) }),
          deployed,
        );
        const path = `/v1/apps/${app.id}`;
        let runId: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (runId !== undefined)
              yield* agent.send(
                "POST",
                `${path}/workflow-runs/${runId}/terminate`,
                undefined,
                headers,
              );
            expect((yield* agent.send("DELETE", path, undefined, headers)).status).toBe(200);
          }).pipe(Effect.orDie),
        );
        const started = yield* agent.send(
          "POST",
          `${path}/workflow-runs`,
          { workflow: "ask", input: { timeoutMs: 86400000, protected: "no" } },
          headers,
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        runId = (yield* body(Schema.Struct({ id: Schema.String }), started)).id;
        const browser = yield* api.session();
        const pairing = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* browser.send("POST", "/auth/pair", undefined, headers),
        );
        expect(
          (yield* api.request(browser, "POST", "/auth/exchange", {
            token: new URL(pairing.url).hash.slice("#pair=".length),
          })).status,
        ).toBe(200);
        const Inputs = Schema.Array(Schema.Struct({ id: Schema.String, run: Schema.String }));
        let question: string | undefined;
        const deadline = (yield* Clock.currentTimeMillis) + 20000;
        while (question === undefined) {
          const response = yield* api.request(
            browser,
            "GET",
            "/dashboard/api/workflow-inputs?pending=true",
          );
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          question = (yield* body(Schema.Struct({ items: Inputs }), response)).items.find(
            (input) => input.run === runId,
          )?.id;
          expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
          if (question === undefined) yield* Effect.sleep("50 millis");
        }
        const answer = { response: { action: "accept", content: { choice: "continue" } } };
        expect(
          (yield* agent.send("POST", `${path}/workflow-inputs/${question}/answer`, answer, headers))
            .status,
        ).toBe(403);
        expect(
          (yield* browser.send(
            "POST",
            `/dashboard/api/apps/${app.id}/workflow-inputs/${question}`,
            answer,
            headers,
          )).status,
        ).toBe(403);
        expect(
          (yield* api.request(
            browser,
            "POST",
            `/dashboard/api/apps/${app.id}/workflow-inputs/${question}`,
            answer,
          )).status,
        ).toBe(200);
        const Run = Schema.Struct({
          status: Schema.String,
          output: Schema.optionalKey(Schema.Json),
        });
        while (true) {
          const run = yield* body(
            Run,
            yield* agent.send("GET", `${path}/workflow-runs/${runId}`, undefined, headers),
          );
          if (run.status === "complete") {
            expect(run.output).toMatchObject({ status: "answered" });
            break;
          }
          expect(run.status).not.toBe("errored");
          expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
          yield* Effect.sleep("50 millis");
        }
      }),
    ),
  );
});
