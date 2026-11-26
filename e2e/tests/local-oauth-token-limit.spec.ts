import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomBytes } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { pairLocalOperator } from "../support/mcp-consent.ts";
import { consentTo, revokeClientGrants } from "../support/mcp-connections.ts";
import { Target } from "../support/platform.ts";

const Registered = Schema.Struct({ client_id: Schema.NonEmptyString });
const TokenError = Schema.Struct({ error: Schema.String });
const refusedRequests = 30;

layer(TestLive, { excludeTestServices: true })("Local OAuth token limit", (it) => {
  it.effect(scenarios.localOAuthTokenLimit.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          http = yield* HttpClient.HttpClient,
          evidence = yield* Evidence;
        const origin = target.metadata.origin;
        const operator = yield* pairLocalOperator;
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);

        const broken = yield* Effect.scoped(
          Effect.gen(function* () {
            const response = yield* http.execute(
              yield* HttpClientRequest.post(`${origin}/api/auth/oauth2/register`).pipe(
                HttpClientRequest.setHeaders({ origin }),
                HttpClientRequest.bodyJson({
                  client_name: "Broken local client",
                  redirect_uris: ["http://127.0.0.1:9/callback"],
                  token_endpoint_auth_method: "none",
                  grant_types: ["authorization_code", "refresh_token"],
                  response_types: ["code"],
                }),
              ),
            );
            expect(response.status).toBe(201);
            const registered = yield* response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Registered)),
            );
            return registered.client_id;
          }),
        );
        const refusals = yield* evidence.step(
          `The broken client makes ${refusedRequests} refresh requests in a row`,
          Effect.forEach(Array.from({ length: refusedRequests }), () =>
            Effect.scoped(
              Effect.gen(function* () {
                const response = yield* http.execute(
                  HttpClientRequest.post(`${origin}/api/auth/oauth2/token`).pipe(
                    HttpClientRequest.bodyUrlParams({
                      grant_type: "refresh_token",
                      client_id: broken,
                      refresh_token: randomBytes(32).toString("base64url"),
                    }),
                  ),
                );
                const answer = yield* response.json.pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Schema.UndefinedOr(TokenError))),
                  Effect.orElseSucceed(() => undefined),
                );
                return { status: response.status, error: answer?.error };
              }),
            ),
          ),
        );
        const consent = yield* evidence.step(
          "Another local client signs in",
          consentTo(operator, undefined),
        );
        clients.push(consent.clientId);
        expect(consent.status).toBe(200);
        yield* evidence.step("The other client exchanges its code for tokens", consent.tokens);
        expect(refusals.filter((refusal) => refusal.status === 429)).toEqual([]);
        expect(new Set(refusals.map((refusal) => refusal.error))).toEqual(
          new Set(["invalid_grant"]),
        );
      }),
    ),
  );
});
