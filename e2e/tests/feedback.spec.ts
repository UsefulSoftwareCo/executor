import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";

layer(HostedLive, { excludeTestServices: true })("Cloud feedback", (it) => {
  it.effect(scenarios.feedback.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const target = yield* Target;
        expect(
          target.metadata.mode,
          "This scenario requires managed Cloud with the local analytics collector",
        ).toBe("managed");
        const anonymous = yield* api.session();
        const route = "/api/organizations/{organization}/feedback";
        const endpoint = `/api/organizations/${actors.organization.id}/feedback`;
        const spec = yield* body(
          Schema.Struct({ paths: Schema.Record(Schema.String, Schema.Unknown) }),
          yield* api.request(anonymous, "GET", "/openapi.json"),
        );
        expect(spec.paths[route]).toMatchObject({
          post: {
            operationId: "feedback.submit",
            security: [{ oauth: ["executor"] }, { browserSession: [] }],
            responses: { "200": {}, "401": {}, "403": {}, "503": {} },
          },
        });
        const feedback = { message: "Synthetic feedback from the public API scenario" };
        expect((yield* api.request(anonymous, "POST", endpoint, feedback)).status).toBe(401);
        expect(
          (yield* api.request(
            actors.member,
            "POST",
            "/api/organizations/nonexistent-feedback-org/feedback",
            feedback,
          )).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.member, "POST", endpoint, feedback, {
            origin: "https://other.example.test",
          })).status,
        ).toBe(403);
        for (const payload of [
          {},
          { message: "" },
          { message: " \n\t" },
          { message: 42 },
          { message: "x".repeat(10_001) },
        ]) {
          expect((yield* api.request(actors.member, "POST", endpoint, payload)).status).toBe(400);
        }
        const accepted = yield* api.request(actors.member, "POST", endpoint, feedback);
        expect(accepted.status).toBe(200);
        expect(accepted.body).toEqual({ status: "accepted" });
      }),
    ),
  );
});
