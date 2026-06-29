// ---------------------------------------------------------------------------
// GraphQL multi-placement auth (wire-level)
//
// The extreme case the unified model exists for: ONE auth method that mixes a
// bearer HEADER and a team-id QUERY PARAM, each rendered from its own
// credential input — plus the single-placement query case, and the explicit
// failure when an input is missing. Assertions are made against what the
// server actually RECEIVED (connect-time introspection and tool invocation).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { graphqlPlugin } from "./plugin";
import { variable } from "@executor-js/sdk/http-auth";
import { makeGreetingGraphqlSchema, serveGraphqlTestServer } from "../testing";

const serveGreetingServer = serveGraphqlTestServer({ schema: makeGreetingGraphqlSchema() });

const makeExecutor = () =>
  createExecutor(
    makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
  );

const toolAddr = (integration: string, connection: string, tool: string): ToolAddress =>
  ToolAddress.make(`tools.${integration}.org.${connection}.${tool}`);

describe("GraphQL multi-placement auth", () => {
  it.effect("the request-shaped authoring dialect lands identically on the wire", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: server.endpoint,
        slug: "authored_gql",
        name: "Authored GraphQL",
        authenticationTemplate: [
          {
            slug: "token_and_team",
            type: "apiKey",
            headers: { Authorization: ["Bearer ", variable("api_token")] },
            queryParams: { team_id: [variable("team_id")] },
          },
        ],
      });

      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("authored_gql"),
        template: AuthTemplateSlug.make("token_and_team"),
        values: { api_token: "tok_A", team_id: "team_B" },
      });

      const requests = yield* server.requests;
      expect(requests.length).toBeGreaterThan(0);
      const last = requests[requests.length - 1]!;
      expect(last.headers["authorization"]).toBe("Bearer tok_A");
      expect(last.url.includes("team_id=team_B")).toBe(true);
    }),
  );

  it.effect("one method renders a bearer header AND a team-id query param", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: server.endpoint,
        slug: "mixed_gql",
        name: "Mixed GraphQL",
        authenticationTemplate: [
          {
            slug: "token_and_team",
            kind: "apikey",
            placements: [
              {
                carrier: "header",
                name: "Authorization",
                prefix: "Bearer ",
                variable: "api_token",
              },
              { carrier: "query", name: "team_id", variable: "team_id" },
            ],
          },
        ],
      });

      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("mixed_gql"),
        template: AuthTemplateSlug.make("token_and_team"),
        values: { api_token: "tok_A", team_id: "team_B" },
      });

      // Connect-time introspection runs WITH the connection's rendered auth —
      // both carriers, each from its own credential input.
      const afterConnect = yield* server.requests;
      const introspections = afterConnect.filter((request) =>
        request.payload.query?.includes("__schema"),
      );
      expect(introspections.length).toBeGreaterThan(0);
      expect(introspections.every((r) => r.headers.authorization === "Bearer tok_A")).toBe(true);
      expect(introspections.every((r) => r.url.includes("team_id=team_B"))).toBe(true);

      yield* server.clearRequests;

      const result = yield* executor.execute(toolAddr("mixed_gql", "main", "query.hello"), {
        name: "Ada",
      });
      expect(result).toEqual({ ok: true, data: { hello: "Hello Ada" } });

      const requests = yield* server.requests;
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((r) => r.headers.authorization === "Bearer tok_A")).toBe(true);
      expect(requests.every((r) => r.url.includes("team_id=team_B"))).toBe(true);
    }),
  );

  it.effect("a query-only method renders ?token= and no Authorization header", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: server.endpoint,
        slug: "query_gql",
        name: "Query GraphQL",
        authenticationTemplate: [
          { kind: "apikey", placements: [{ carrier: "query", name: "token" }] },
        ],
      });

      // Slug-less single-query-placement methods get the `query` slug.
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("query_gql"),
        template: AuthTemplateSlug.make("query"),
        value: "tok_secret_123",
      });

      yield* server.clearRequests;

      const result = yield* executor.execute(toolAddr("query_gql", "main", "query.hello"), {
        name: "Ada",
      });
      expect(result).toEqual({ ok: true, data: { hello: "Hello Ada" } });

      const requests = yield* server.requests;
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((r) => r.url.includes("token=tok_secret_123"))).toBe(true);
      expect(requests.every((r) => r.headers.authorization === undefined)).toBe(true);
    }),
  );

  it.effect("invoking with a missing credential input fails explicitly, not silently", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: server.endpoint,
        slug: "strict_gql",
        name: "Strict GraphQL",
        authenticationTemplate: [
          {
            slug: "two_inputs",
            kind: "apikey",
            placements: [
              { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "a" },
              { carrier: "query", name: "team_id", variable: "b" },
            ],
          },
        ],
      });

      // Only one of the two inputs is supplied.
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("half"),
        integration: IntegrationSlug.make("strict_gql"),
        template: AuthTemplateSlug.make("two_inputs"),
        values: { a: "tok_A" },
      });

      const result = (yield* executor.execute(toolAddr("strict_gql", "half", "query.hello"), {
        name: "Ada",
      })) as { ok: boolean; error?: { code?: string; message?: string } };
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({ code: "connection_value_missing" });
      expect(String(result.error?.message ?? "")).toContain("b");
    }),
  );
});
