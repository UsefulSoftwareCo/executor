/** Registration checks every persisted resource without signing in or triggering app setup. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";

layer(TestLive, { excludeTestServices: true })("OAuth provisioning", (it) => {
  it.effect(scenarios.oauthProvisioning.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const target = yield* Target;
        const origin = target.metadata.origin;
        const resources = [
          `${origin}/mcp`,
          `${origin}/mcp?elicitation_mode=native`,
          `${origin}/mcp?elicitation_mode=browser`,
          ...(target.metadata.target === "local" ? [] : [`${origin}/api`]),
        ];
        const session = yield* api.session();
        const response = yield* api.request(session, "POST", "/api/auth/oauth2/register", {
          client_name: "OAuth provisioning fixture",
          redirect_uris: ["https://client.example.test/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          resources,
        });
        expect(response.status).toBe(201);
        const registered = yield* body(
          Schema.Struct({ client_id: Schema.NonEmptyString }),
          response,
        );
        expect(registered.client_id.length).toBeGreaterThan(0);
      }),
    ),
  );
});
