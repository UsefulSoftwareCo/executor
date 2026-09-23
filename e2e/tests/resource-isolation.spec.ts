import { createProfile } from "../support/profiles.ts";
/** Real Cloud organizations exercise tenant boundaries through the hosted API. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource, Organization } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
const Access = Schema.Struct({ revision: Schema.String });
const Group = Schema.Struct({ id: Schema.String, revision: Schema.String });
const singleSource = `import {defineApp, defineProvider, secrets, query, object, string} from "apps";
const service=defineProvider({name:"Group isolation fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export default defineApp({accounts:{service}},async ctx=>({name:"Isolation",queries:{identity:query({input:object({})},async()=>ctx.accounts.service.fields.token)}}));`;
layer(HostedLive, { excludeTestServices: true })("Resource isolation", (it) => {
  it.effect(scenarios.resourceIsolation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const suffix = randomUUID().slice(0, 8);
        const other = yield* body(
          Organization,
          yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
            name: "Resource isolation",
            slug: `resource-${suffix}`,
            keepCurrentActiveOrganization: true,
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `/api/organizations/${other.id}`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
        );
        const prefix = `/api/organizations/${actors.organization.id}`,
          foreign = `/api/organizations/${other.id}`;
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Isolation ${suffix}`,
            files: [{ path: "index.ts", content: singleSource }],
          }),
        );
        const group = yield* body(
          Group,
          yield* api.request(actors.owner, "POST", `${prefix}/groups`, {
            name: `Isolation ${suffix}`,
            description: "",
            memberIds: [],
          }),
        );
        const saved: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            expect(
              (yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`)).status,
            ).toBe(200);
            for (const account of saved)
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`))
                  .status,
              ).toBe(200);
            expect(
              (yield* api.request(actors.owner, "DELETE", `${prefix}/groups/${group.id}`, {
                revision: group.revision,
              })).status,
            ).toBe(200);
          }).pipe(Effect.orDie),
        );
        const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
        const second = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${foreign}/apps/deploy`, {
            name: `Isolation ${suffix}`,
            files: [{ path: "index.ts", content: singleSource }],
          }),
        );
        for (const endpoint of ["", "/tools", "/source", "/access"])
          expect(
            (yield* api.request(actors.owner, "GET", `${foreign}/apps/${app.id}${endpoint}`))
              .status,
          ).toBe(403);
        expect(
          (yield* api.request(actors.owner, "POST", `${foreign}/apps/${app.id}/tools/call`, {
            profile: profile.id,
            tool: "queries.identity",
            input: {},
          })).status,
        ).toBe(403);
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${foreign}/apps/${second.id}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${foreign}/apps/${second.id}/access`, {
            revision: access.revision,
            audience: { kind: "groups", groups: [group.id] },
          })).status,
        ).toBe(403);
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
            requirement: "service",
            profile: profile.id,
          }),
        );
        expect(
          (yield* api.request(
            actors.owner,
            "POST",
            `${foreign}/connections/${connection.id}/submit`,
            { method: "key", label: "Foreign", fields: { token: "synthetic" } },
          )).status,
        ).toBe(404);
        const account = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            { method: "key", label: "Personal isolation", fields: { token: "synthetic" } },
          ),
        );
        saved.push(account.id);
        expect(
          (yield* api.request(actors.owner, "POST", `${foreign}/apps/${second.id}/profiles`, {
            idempotencyKey: randomUUID(),
            accounts: { service: account.id },
          })).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.owner, "GET", `${foreign}/accounts/${account.id}`)).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/tools/call`, {
            profile: profile.id,
            tool: "queries.identity",
            input: {},
          })).body,
        ).toBe("synthetic");
        expect((yield* api.request(actors.member, "GET", `${foreign}/inventory`)).status).toBe(403);
      }),
    ),
  );
});
