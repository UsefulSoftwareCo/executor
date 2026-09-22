/** Real hosted group checks cover fixed account bindings and current app authoring routes. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { App, Resource, Inventory } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

const Access = Schema.Struct({
  revision: Schema.String,
  canUse: Schema.Boolean,
  canManage: Schema.Boolean,
});
const Group = Schema.Struct({ id: Schema.String, revision: Schema.String });
const Groups = Schema.Struct({
  members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
});
const identitySource = `import {defineApp, query, object} from "apps";
export default defineApp({accounts:{}},{name:"Access fixture", queries:{identity:query({input:object({})},async()=>"allowed")}});`;
const arraySource = `import {defineApp, defineProvider, secrets, query, object, string} from "apps";
const service=defineProvider({name:"Group array fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export default defineApp({accounts:{service:service.many()}},async ctx=>({name:"Group array",queries:{identity:query({input:object({})},async()=>ctx.accounts.service.map(account=>account.fields.token))}}));`;
const singleSource = arraySource
  .replace("service:service.many()", "service")
  .replace(
    "ctx.accounts.service.map(account=>account.fields.token)",
    "ctx.accounts.service.fields.token",
  );

layer(HostedLive, { excludeTestServices: true })("Resource access", (it) => {
  it.effect(scenarios.resourceAccess.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const suffix = randomUUID().slice(0, 8);
        const created: { apps: string[]; accounts: string[]; groups: string[] } = {
          apps: [],
          accounts: [],
          groups: [],
        };
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const app of created.apps)
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app}`)).status,
              ).toBe(200);
            for (const account of created.accounts)
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`))
                  .status,
              ).toBe(200);
            for (const id of created.groups) {
              const group = yield* body(
                Group,
                yield* api.request(actors.owner, "GET", `${prefix}/groups/${id}`),
              );
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/groups/${id}`, {
                  revision: group.revision,
                })).status,
              ).toBe(200);
            }
          }).pipe(Effect.orDie),
        );
        const members = yield* body(
          Groups,
          yield* api.request(actors.owner, "GET", `${prefix}/groups`),
        );
        const memberIdentity = yield* body(
          Schema.Struct({ userId: Schema.String }),
          yield* api.request(actors.member, "GET", "/api/viewer"),
        );
        const adminIdentity = yield* body(
          Schema.Struct({ userId: Schema.String }),
          yield* api.request(actors.admin, "GET", "/api/viewer"),
        );
        const member = members.members.find((item) => item.userId === memberIdentity.userId);
        const admin = members.members.find((item) => item.userId === adminIdentity.userId);
        if (!member || !admin) throw new Error("Missing synthetic group members");
        const sales = yield* body(
          Group,
          yield* api.request(actors.owner, "POST", `${prefix}/groups`, {
            name: `Sales ${suffix}`,
            description: "",
            memberIds: [admin.id],
          }),
        );
        const engineering = yield* body(
          Group,
          yield* api.request(actors.owner, "POST", `${prefix}/groups`, {
            name: `Engineering ${suffix}`,
            description: "",
            memberIds: [member.id],
          }),
        );
        created.groups.push(sales.id, engineering.id);
        const deployment = yield* api.request(actors.member, "POST", `${prefix}/apps/deploy`, {
          name: `Private ${suffix}`,
          files: [{ path: "index.ts", content: identitySource }],
        });
        expect(deployment.status).toBe(200);
        const app = yield* body(App, deployment);
        created.apps.push(app.id);
        const call = { tool: "queries.identity", input: {} };
        expect(
          (yield* api.request(actors.member, "POST", `${prefix}/apps/${app.id}/tools/call`, call))
            .body,
        ).toBe("allowed");
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/tools/call`, call))
            .status,
        ).toBe(403);
        const normal = yield* body(
          Inventory,
          yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
        );
        expect(normal.apps.some((item) => item.id === app.id)).toBe(false);
        const management = yield* body(
          Schema.Struct({ apps: Schema.Array(Schema.Struct({ app: App })) }),
          yield* api.request(actors.owner, "GET", `${prefix}/resources?view=managed`),
        );
        expect(management.apps.some((item) => item.app.id === app.id)).toBe(true);
        const initial = yield* body(
          Access,
          yield* api.request(actors.member, "GET", `${prefix}/apps/${app.id}/access`),
        );
        expect(
          (yield* api.request(actors.member, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: initial.revision,
            audience: { kind: "groups", groups: [sales.id, engineering.id] },
          })).status,
        ).toBe(403);
        expect(
          yield* body(
            Access,
            yield* api.request(actors.member, "GET", `${prefix}/apps/${app.id}/access`),
          ),
        ).toEqual(initial);
        const ownShare = yield* body(
          Access,
          yield* api.request(actors.member, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: initial.revision,
            audience: { kind: "groups", groups: [engineering.id] },
          }),
        );
        expect(
          (yield* api.request(actors.admin, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: ownShare.revision,
            audience: { kind: "groups", groups: [sales.id, engineering.id] },
          })).status,
        ).toBe(200);
        expect(
          (yield* api.request(actors.admin, "POST", `${prefix}/apps/${app.id}/tools/call`, call))
            .status,
        ).toBe(200);
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/tools/call`, call))
            .status,
        ).toBe(403);
        const shared = yield* body(
          Inventory,
          yield* api.request(actors.member, "GET", `${prefix}/inventory`),
        );
        expect(shared.apps.filter((item) => item.id === app.id)).toHaveLength(1);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/groups/${engineering.id}`, {
            name: `Engineering ${suffix}`,
            description: "",
            memberIds: [],
            revision: engineering.revision,
          })).status,
        ).toBe(200);
        expect(
          (yield* api.request(actors.member, "POST", `${prefix}/apps/${app.id}/tools/call`, call))
            .status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.admin, "POST", `${prefix}/apps/${app.id}/tools/call`, call))
            .status,
        ).toBe(200);

        const array = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Array ${suffix}`,
            files: [{ path: "index.ts", content: arraySource }],
          }),
        );
        created.apps.push(array.id);
        const arrayAccess = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${array.id}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${array.id}/access`, {
            revision: arrayAccess.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const personalConnection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/${array.id}/connections`, {
            requirement: "service",
            destination: { kind: "personal" },
          }),
        );
        const personal = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${personalConnection.id}/submit`,
            { method: "key", label: "Personal fixture", fields: { token: "personal" } },
          ),
        );
        created.accounts.push(personal.id);
        const teamConnection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/${array.id}/connections`, {
            requirement: "service",
            destination: { kind: "shared", audience: { kind: "groups", groups: [sales.id] } },
          }),
        );
        const team = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${teamConnection.id}/submit`,
            { method: "key", label: "Sales fixture", fields: { token: "team" } },
          ),
        );
        created.accounts.push(team.id);
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/accounts/${team.id}`)).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.admin, "GET", `${prefix}/accounts/${personal.id}`)).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/apps/${array.id}/tools/call`, call))
            .status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.admin, "POST", `${prefix}/apps/${array.id}/tools/call`, call))
            .status,
        ).toBe(403);
        const teamAccess = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${prefix}/accounts/${team.id}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/accounts/${team.id}/access`, {
            revision: teamAccess.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const allowed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${array.id}/tools/call`,
          call,
        );
        expect(allowed.status).toBe(200);
        expect(allowed.body).toEqual(["personal", "team"]);
        expect(
          (yield* api.request(actors.admin, "POST", `${prefix}/apps/${array.id}/tools/call`, call))
            .status,
        ).toBe(403);
        const workspace = yield* body(
          Schema.Struct({
            canEdit: Schema.Boolean,
            revision: Schema.Struct({ commit: Schema.String }),
          }),
          yield* api.request(actors.admin, "GET", `${prefix}/apps/${array.id}/workspace`),
        );
        expect(workspace.canEdit).toBe(false);
        expect(
          (yield* api.request(actors.admin, "POST", `${prefix}/apps/${array.id}/commits`, {
            expected: workspace.revision.commit,
            files: [{ path: "index.ts", content: arraySource }],
            message: "Denied edit",
          })).status,
        ).toBe(403);
        const authoringList = yield* api.request(actors.admin, "GET", `${prefix}/apps`);
        expect(authoringList.status).toBe(200);
        expect(JSON.stringify(authoringList.body)).not.toContain(personal.id);
        const redacted = yield* api.request(
          actors.admin,
          "PATCH",
          `${prefix}/apps/${array.id}/name`,
          { name: `Array renamed ${suffix}` },
        );
        expect(redacted.status).toBe(200);
        expect(JSON.stringify(redacted.body)).not.toContain(personal.id);
        const single = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Single ${suffix}`,
            files: [{ path: "index.ts", content: singleSource }],
          }),
        );
        created.apps.push(single.id);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${single.id}/accounts`, {
            accounts: { service: personal.id },
          })).status,
        ).toBe(200);
        expect(
          (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${personal.id}`)).status,
        ).toBe(200);
        created.accounts.splice(created.accounts.indexOf(personal.id), 1);
        const bindings = Schema.Struct({
          accounts: Schema.Record(
            Schema.String,
            Schema.Union([Schema.String, Schema.Array(Schema.String)]),
          ),
        });
        expect(
          (yield* body(
            bindings,
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${array.id}`),
          )).accounts,
        ).toEqual({ service: [team.id] });
        expect(
          (yield* body(
            bindings,
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${single.id}`),
          )).accounts,
        ).toEqual({});
        expect(
          (yield* api.request(actors.admin, "POST", `${prefix}/apps/${array.id}/tools/call`, call))
            .body,
        ).toEqual(["team"]);
        expect(
          (yield* body(
            Inventory,
            yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
          )).accounts.some((item) => item.id === personal.id),
        ).toBe(false);
        expect(
          (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${team.id}`)).status,
        ).toBe(200);
        created.accounts.splice(created.accounts.indexOf(team.id), 1);
        expect(
          (yield* body(
            bindings,
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${array.id}`),
          )).accounts,
        ).toEqual({});
      }),
    ),
  );
  it.effect(scenarios.groupAuthoring.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`,
          suffix = randomUUID().slice(0, 8);
        const created: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const id of created)
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${id}`)).status,
              ).toBe(200);
          }).pipe(Effect.orDie),
        );
        const draft = yield* body(
          App,
          yield* api.request(actors.member, "POST", `${prefix}/apps/drafts`, {
            name: `Member draft ${suffix}`,
            files: [{ path: "index.ts", content: identitySource }],
          }),
        );
        created.push(draft.id);
        const draftAccess = yield* api.request(
          actors.member,
          "GET",
          `${prefix}/apps/${draft.id}/access`,
        );
        expect(draftAccess.status).toBe(200);
        expect(draftAccess.body).toMatchObject({
          audience: { kind: "private" },
          canManage: true,
          canUse: true,
        });
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/apps/${draft.id}/workspace`)).status,
        ).toBe(200);
        const copied = yield* body(
          App,
          yield* api.request(actors.member, "POST", `${prefix}/apps/copies`, {
            from: { app: draft.id },
            name: `Member copy ${suffix}`,
          }),
        );
        created.push(copied.id);
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/apps/${copied.id}/access`)).body,
        ).toMatchObject({ audience: { kind: "private" }, canManage: true, canUse: true });
        const hidden = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/drafts`, {
            name: `Owner draft ${suffix}`,
            files: [{ path: "index.ts", content: identitySource }],
          }),
        );
        created.push(hidden.id);
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/apps/${hidden.id}/workspace`))
            .status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.member, "POST", `${prefix}/apps/copies`, {
            from: { app: hidden.id },
            name: `Forbidden copy ${suffix}`,
          })).status,
        ).toBe(403);
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${hidden.id}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${hidden.id}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const listed = yield* body(
          Schema.Array(App),
          yield* api.request(actors.member, "GET", `${prefix}/apps`),
        );
        expect(listed.map((app) => app.id)).toContain(hidden.id);
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/apps/${hidden.id}/workspace`))
            .status,
        ).toBe(403);
      }),
    ),
  );
});
