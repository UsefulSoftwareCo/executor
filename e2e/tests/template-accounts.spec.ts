/** Multi-account defaults are verified through imported source and public profile/tool APIs. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { templateUpstream } from "../support/template-upstream.ts";
import { scenarios } from "../test-plan.ts";

const Profile = Schema.Struct({
  id: Schema.String,
  revision: Schema.Number,
  accounts: Schema.Struct({ service: Schema.Array(Schema.String) }),
});
const Tools = Schema.Struct({
  items: Schema.Array(Schema.Struct({ name: Schema.String, inputSchema: Schema.Json })),
});

layer(HostedLive, { excludeTestServices: true })("Template accounts", (it) => {
  it.effect(scenarios.templateAccounts.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          origin = yield* templateUpstream;
        const prefix = `/api/organizations/${actors.organization.id}`;
        for (const kind of ["openapi", "mcp", "graphql"] as const) {
          const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
            source:
              kind === "openapi"
                ? {
                    kind,
                    name: `Accounts ${kind} ${randomUUID().slice(0, 8)}`,
                    url: `${origin}/openapi.json`,
                    baseUrl: origin,
                  }
                : {
                    kind,
                    name: `Accounts ${kind} ${randomUUID().slice(0, 8)}`,
                    url: `${origin}/${kind}`,
                    auth: { type: "apiKey", header: "Authorization", prefix: "Bearer " },
                  },
          });
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          const app = yield* body(App, response),
            path = `${prefix}/apps/${app.id}`;
          const accounts: string[] = [];
          let profileId: string | undefined;
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              if (profileId !== undefined)
                yield* api.request(actors.owner, "DELETE", `${path}/profiles/${profileId}`);
              yield* api.request(actors.owner, "DELETE", path);
              for (const id of accounts)
                yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
            }).pipe(Effect.orDie),
          );
          const create = yield* api.request(actors.owner, "POST", `${path}/profiles`, {
            accounts: { service: [] },
            idempotencyKey: randomUUID(),
          });
          expect(
            create.status,
            `${kind} accepts an account array: ${JSON.stringify(create.body)}`,
          ).toBe(200);
          let profile = yield* body(Profile, create);
          profileId = profile.id;
          const catalog = () =>
            api.request(actors.owner, "GET", `${path}/tools?profile=${profile.id}`);
          const empty = yield* catalog();
          expect(empty.status, JSON.stringify(empty.body)).toBe(200);
          expect((yield* body(Tools, empty)).items).toEqual([]);
          for (const label of ["work", "personal"]) {
            const start = yield* api.request(actors.owner, "POST", `${path}/connections`, {
              requirement: "service",
              profile: profile.id,
            });
            expect(start.status, JSON.stringify(start.body)).toBe(200);
            const connection = yield* body(Resource, start);
            const saved = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              {
                method: "apiKey",
                label,
                fields: { token: `synthetic-${label}` },
              },
            );
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            accounts.push((yield* body(Resource, saved)).id);
          }
          profile = yield* body(
            Profile,
            yield* api.request(actors.owner, "GET", `${path}/profiles/${profile.id}`),
          );
          expect(profile.accounts.service).toEqual(accounts);
          const tools = yield* catalog();
          expect(tools.status, JSON.stringify(tools.body)).toBe(200);
          const tool = kind === "graphql" ? "queries.query_identity" : "queries.identity";
          expect((yield* body(Tools, tools)).items.map((item) => item.name)).toEqual([tool]);
          if (kind === "mcp") {
            const descriptions = JSON.stringify((yield* body(Tools, tools)).items);
            expect(descriptions).toContain('"value"');
            expect(descriptions).toContain('"work"');
            expect(descriptions).toContain('"#/anyOf/0/properties/input/$defs/Value"');
            expect(descriptions).toContain('"#/anyOf/1/properties/input/$defs/Value"');
          }
          const call = (accountId: string, label: string) =>
            api.request(actors.owner, "POST", `${path}/tools/call`, {
              profile: profile.id,
              tool,
              input: { accountId, input: kind === "mcp" ? { value: label } : {} },
            });
          for (const [index, label] of ["work", "personal"].entries()) {
            const id = accounts[index];
            if (id === undefined) return yield* Effect.die("Account fixture missing");
            const called = yield* call(id, label);
            expect(called.status, `${kind}: ${JSON.stringify(called.body)}`).toBe(200);
            if (kind === "mcp")
              expect(called.body).toMatchObject({ structuredContent: { account: label } });
            else expect(called.body).toEqual(kind === "graphql" ? label : { account: label });
            if (kind === "mcp") {
              const wrongSchema = yield* call(id, label === "work" ? "personal" : "work");
              expect(wrongSchema.status).toBeGreaterThanOrEqual(400);
              expect(wrongSchema.status).toBeLessThan(500);
            }
          }
          const removed = accounts[0],
            retained = accounts[1];
          if (removed === undefined || retained === undefined)
            return yield* Effect.die("Account fixtures missing");
          const updated = yield* api.request(
            actors.owner,
            "PATCH",
            `${path}/profiles/${profile.id}`,
            {
              expectedRevision: profile.revision,
              accounts: { service: [retained] },
            },
          );
          expect(updated.status, JSON.stringify(updated.body)).toBe(200);
          const rejected = yield* call(removed, "work");
          expect(rejected.status).toBeGreaterThanOrEqual(400);
          expect(rejected.status).toBeLessThan(500);
          const stillAvailable = yield* call(retained, "personal");
          expect(stillAvailable.status, JSON.stringify(stillAvailable.body)).toBe(200);
        }
      }),
    ),
  );
});
