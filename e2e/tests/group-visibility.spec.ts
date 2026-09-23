import { createProfile } from "../support/profiles.ts";
/** Group boundaries apply to discovery, sharing, and pending account connections. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

const Group = Schema.Struct({ id: Schema.String, revision: Schema.String });
const Directory = Schema.Struct({
  groups: Schema.Array(Group),
  members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
});
const Access = Schema.Struct({ revision: Schema.String });
const source = `import {defineApp, defineProvider, secrets, query, object, string} from "apps";
const service=defineProvider({name:"Group visibility fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export default defineApp({accounts:{service:service.many()}},{queries:{status:query({input:object({})},async()=>"ready")}});`;

layer(HostedLive, { excludeTestServices: true })("Group visibility", (it) => {
  it.effect(scenarios.memberGroupVisibility.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const suffix = randomUUID().slice(0, 8);
        const names = { engineering: `Engineering ${suffix}`, sales: `Sales ${suffix}` };
        const directory = yield* body(
          Directory,
          yield* api.request(actors.owner, "GET", `${prefix}/groups`),
        );
        const identity = yield* body(
          Schema.Struct({ userId: Schema.String }),
          yield* api.request(actors.member, "GET", "/api/viewer"),
        );
        const member = directory.members.find((item) => item.userId === identity.userId);
        if (!member) throw new Error("Synthetic member missing");
        const outsider = directory.members.find((item) => item.userId !== identity.userId);
        if (!outsider) throw new Error("Synthetic outside-group member missing");
        const engineering = yield* body(
          Group,
          yield* api.request(actors.owner, "POST", `${prefix}/groups`, {
            name: names.engineering,
            description: "",
            memberIds: [member.id],
          }),
        );
        const sales = yield* body(
          Group,
          yield* api.request(actors.owner, "POST", `${prefix}/groups`, {
            name: names.sales,
            description: "",
            memberIds: [outsider.id],
          }),
        );
        const app = yield* body(
          App,
          yield* api.request(actors.member, "POST", `${prefix}/apps/deploy`, {
            name: `Visibility ${suffix}`,
            files: [{ path: "index.ts", content: source }],
          }),
        );
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            expect(
              (yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`)).status,
            ).toBe(200);
            for (const account of accounts)
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`))
                  .status,
              ).toBe(200);
            for (const group of [engineering, sales]) {
              const current = yield* body(
                Group,
                yield* api.request(actors.owner, "GET", `${prefix}/groups/${group.id}`),
              );
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/groups/${group.id}`, {
                  revision: current.revision,
                })).status,
              ).toBe(200);
            }
          }).pipe(Effect.orDie),
        );

        const visible = yield* body(
          Directory,
          yield* api.request(actors.member, "GET", `${prefix}/groups`),
        );
        expect(visible.groups.map((group) => group.id)).toContain(engineering.id);
        expect(visible.groups.map((group) => group.id)).not.toContain(sales.id);
        expect(visible.members.map((person) => person.id)).not.toContain(outsider.id);
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/groups/${sales.id}`)).status,
        ).toBe(404);
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/groups/${engineering.id}`)).status,
        ).toBe(200);
        for (const actor of [actors.admin, actors.owner]) {
          const all = yield* body(Directory, yield* api.request(actor, "GET", `${prefix}/groups`));
          expect(all.groups.map((group) => group.id)).toEqual(
            expect.arrayContaining([engineering.id, sales.id]),
          );
          expect((yield* api.request(actor, "GET", `${prefix}/groups/${sales.id}`)).status).toBe(
            200,
          );
        }

        yield* browser.login(actors.member);
        yield* browser.use("Open member groups", (page) =>
          page.goto(`/org/${actors.organization.slug}/groups`),
        );
        yield* browser.use("Engineering is visible", (page) =>
          page.getByRole("heading", { name: names.engineering, exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Sales is hidden", (page) =>
            page.getByRole("heading", { name: names.sales, exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.use("Open hidden group directly", (page) =>
          page.goto(`/org/${actors.organization.slug}/groups/${sales.id}`),
        );
        yield* browser.use("Hidden group is unavailable", (page) =>
          page.getByRole("heading", { name: "Group unavailable" }).waitFor(),
        );
        yield* browser.use("Open the member app list", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("Open app filters", (page) =>
          page.getByRole("button", { name: "Filters", exact: true }).click(),
        );
        yield* browser.use("Open group filter", (page) =>
          page.getByRole("combobox", { name: "Filter apps by group" }).click(),
        );
        yield* browser.use("Engineering appears in the app filter", (page) =>
          page.getByRole("option", { name: names.engineering, exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Sales is hidden from the app filter", (page) =>
            page.getByRole("option", { name: names.sales, exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.use("Open app Settings", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=settings`),
        );
        yield* browser.use("Choose app audience", (page) =>
          page.getByRole("combobox", { name: "Who can use this app?" }).click(),
        );
        yield* browser.use("Choose groups", (page) =>
          page.getByRole("option", { name: "Selected groups", exact: true }).click(),
        );
        yield* browser.use("Choose Engineering", (page) =>
          page.getByRole("checkbox", { name: names.engineering, exact: true }).check(),
        );
        expect(
          yield* browser.use("Sales is absent from sharing", (page) =>
            page.getByRole("checkbox", { name: names.sales, exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.use("Save own-group sharing", (page) =>
          page.getByRole("button", { name: "Save access", exact: true }).click(),
        );
        yield* browser.use("Sharing saved", (page) =>
          page.getByRole("status").filter({ hasText: "Saved" }).waitFor(),
        );
        yield* browser.checkpoint("Member sees only their own groups in directory and sharing");

        const ownAudience = { kind: "groups", groups: [engineering.id] };
        const salesAudience = { kind: "groups", groups: [sales.id] };
        const profile = yield* createProfile(actors.member, `${prefix}/apps/${app.id}`);
        const connect = (audience: typeof ownAudience) =>
          api.request(actors.member, "POST", `${prefix}/apps/${app.id}/connections`, {
            requirement: "service",
            profile: profile.id,
            destination: { kind: "shared", audience },
          });
        expect((yield* connect(salesAudience)).status).toBe(403);
        const connection = yield* body(Resource, yield* connect(ownAudience));
        const submit = (id: string) =>
          api.request(actors.member, "POST", `${prefix}/connections/${id}/submit`, {
            method: "key",
            label: "Team visibility",
            fields: { token: "synthetic" },
          });
        expect((yield* submit(connection.id)).status).toBe(200);
        const binding = yield* body(
          Schema.Struct({ accounts: Schema.Struct({ service: Schema.Array(Schema.String) }) }),
          yield* api.request(
            actors.member,
            "GET",
            `${prefix}/apps/${app.id}/profiles/${profile.id}`,
          ),
        );
        accounts.push(...binding.accounts.service);
        const account = accounts[0];
        if (!account) throw new Error("Shared account missing");
        const accountAccess = yield* body(
          Access,
          yield* api.request(actors.member, "GET", `${prefix}/accounts/${account}/access`),
        );
        expect(
          (yield* api.request(actors.member, "PATCH", `${prefix}/accounts/${account}/access`, {
            revision: accountAccess.revision,
            audience: salesAudience,
          })).status,
        ).toBe(403);
        const pending = yield* body(Resource, yield* connect(ownAudience));

        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/groups/${engineering.id}`, {
            name: names.engineering,
            description: "",
            revision: engineering.revision,
            memberIds: [],
          })).status,
        ).toBe(200);
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/groups/${engineering.id}`)).status,
        ).toBe(404);
        const afterRemoval = yield* body(
          Directory,
          yield* api.request(actors.member, "GET", `${prefix}/groups`),
        );
        expect(afterRemoval.groups.map((group) => group.id)).not.toContain(engineering.id);
        const current = yield* body(
          Access,
          yield* api.request(actors.member, "GET", `${prefix}/apps/${app.id}/access`),
        );
        expect(
          (yield* api.request(actors.member, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: current.revision,
            audience: ownAudience,
          })).status,
        ).toBe(403);
        expect((yield* submit(pending.id)).status).toBe(403);
        const removed = yield* body(
          Group,
          yield* api.request(actors.owner, "GET", `${prefix}/groups/${engineering.id}`),
        );
        expect(
          (yield* api.request(actors.admin, "PATCH", `${prefix}/groups/${engineering.id}`, {
            name: names.engineering,
            description: "",
            revision: removed.revision,
            memberIds: [member.id],
          })).status,
        ).toBe(200);
        const after = yield* body(
          Schema.Struct({ accounts: Schema.Struct({ service: Schema.Array(Schema.String) }) }),
          yield* api.request(
            actors.member,
            "GET",
            `${prefix}/apps/${app.id}/profiles/${profile.id}`,
          ),
        );
        expect(after.accounts.service).toEqual(accounts);
        expect(
          (yield* api.request(actors.admin, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: current.revision,
            audience: salesAudience,
          })).status,
        ).toBe(200);
      }),
    ),
  );
});
