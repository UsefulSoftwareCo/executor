/**
 * A database failure while verifying an API key is an outage, not a bad key. MCP and the API
 * answer 503 so agents retry instead of discarding a working key; a refused key still gets 401.
 * Requests that verify one key together contend for its row: all succeed, and the key's use is
 * recorded once.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientRequest } from "effect/http";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";

const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });

const Fault = Schema.Struct({
  fault: Schema.Literals(["install", "slow", "remove"]),
  writes: Schema.optional(Schema.Number),
});

/** Fail, slow or restore PostgreSQL writes to one key's row in the local database. */
const storageFault = (key: string, fault: "install" | "slow" | "remove") =>
  Effect.gen(function* () {
    const target = yield* Target,
      evidence = yield* Evidence;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = yield* evidence.step(
      {
        install: "Fail the key's database writes",
        slow: "Slow and count the key's database writes",
        remove: "Restore the key's database writes",
      }[fault],
      processes.string(
        ChildProcess.make(
          "node",
          [
            "apps/hosted/testing/api-key-storage-fixture.ts",
            "--configuration",
            `${target.directory}/sso-database.json`,
            "--key",
            key,
            "--fault",
            fault,
          ],
          { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, extendEnv: false },
        ),
      ),
    );
    const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Fault))(output);
    expect(result.fault).toBe(fault);
    return result;
  });

layer(HostedLive, { excludeTestServices: true })("API key storage outage", (it) => {
  it.effect(scenarios.apiKeyStorageOutage.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target,
          http = yield* HttpClient.HttpClient;
        const anonymous = yield* api.session();
        const organization = actors.organization.id;
        const key = yield* body(
          Key,
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Storage outage",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        // Well formed, but no such key exists.
        const refused = Redacted.make(`exp_${"0".repeat(64)}`);
        // Programmatic MCP clients send no Origin; the status and challenge are the outcome.
        const mcp = (token: Redacted.Redacted<string>) =>
          Effect.scoped(
            Effect.gen(function* () {
              const request = yield* HttpClientRequest.post(`${target.metadata.origin}/mcp`).pipe(
                HttpClientRequest.bearerToken(token),
                HttpClientRequest.setHeaders({
                  accept: "application/json, text/event-stream",
                  "x-executor-organization": organization,
                }),
                HttpClientRequest.bodyJson({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "initialize",
                  params: {
                    protocolVersion: "2025-11-25",
                    capabilities: {},
                    clientInfo: { name: "storage-outage-e2e", version: "1" },
                  },
                }),
              );
              const response = yield* http.execute(request);
              yield* response.text;
              return {
                status: response.status,
                challenge: response.headers["www-authenticate"],
              };
            }),
          ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
        const inventory = (token: Redacted.Redacted<string>) =>
          api.request(anonymous, "GET", `/api/organizations/${organization}/inventory`, undefined, {
            authorization: `Bearer ${Redacted.value(token)}`,
          });

        expect((yield* mcp(key.key)).status, "The key opens MCP").toBe(200);
        expect((yield* inventory(key.key)).status, "The key reads the API").toBe(200);

        yield* storageFault(key.id, "install");
        yield* Effect.addFinalizer(() => storageFault(key.id, "remove").pipe(Effect.orDie));
        const unavailable = yield* mcp(key.key);
        expect(unavailable.status, "MCP reports the outage").toBe(503);
        expect(unavailable.challenge, "MCP does not ask for new credentials").toBeUndefined();
        const apiUnavailable = yield* inventory(key.key);
        expect(apiUnavailable.status, "The API reports the outage").toBe(503);
        expect(apiUnavailable.body).toMatchObject({ _tag: "AuthenticationUnavailable" });

        // During the same outage, a key Better Auth refuses is still a credential failure.
        const invalid = yield* mcp(refused);
        expect(invalid.status, "MCP refuses an unknown key").toBe(401);
        expect(invalid.challenge).toContain("resource_metadata=");
        expect((yield* inventory(refused)).status, "The API refuses an unknown key").toBe(401);

        // The outage never invalidated the key.
        yield* storageFault(key.id, "remove");
        expect((yield* mcp(key.key)).status, "The key opens MCP again").toBe(200);
        expect((yield* inventory(key.key)).status, "The key reads the API again").toBe(200);
      }),
    ),
  );

  it.effect(scenarios.apiKeyConcurrentUse.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const anonymous = yield* api.session();
        const organization = actors.organization.id;
        const key = yield* body(
          Key,
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Concurrent use",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const inventory = api.request(
          anonymous,
          "GET",
          `/api/organizations/${organization}/inventory`,
          undefined,
          { authorization: `Bearer ${Redacted.value(key.key)}` },
        );

        // The key's use is unrecorded and its first write holds the row, so every request
        // below reads the key before that write commits.
        yield* storageFault(key.id, "slow");
        yield* Effect.addFinalizer(() => storageFault(key.id, "remove").pipe(Effect.orDie));
        const statuses = yield* Effect.all(
          Array.from({ length: 4 }, () => inventory),
          {
            concurrency: "unbounded",
          },
        );
        expect(
          statuses.map((response) => response.status),
          "Every request with the key succeeds",
        ).toEqual([200, 200, 200, 200]);
        const restored = yield* storageFault(key.id, "remove");
        expect(restored.writes, "The key's use is recorded once").toBe(1);
        const keys = yield* body(
          Schema.Struct({
            apiKeys: Schema.Array(
              Schema.Struct({ id: Schema.String, lastRequest: Schema.NullOr(Schema.String) }),
            ),
          }),
          yield* api.request(actors.owner, "GET", "/api/auth/api-key/list?offset=0"),
        );
        expect(keys.apiKeys.find((item) => item.id === key.id)?.lastRequest).toBeTypeOf("string");
      }),
    ),
  );
});
