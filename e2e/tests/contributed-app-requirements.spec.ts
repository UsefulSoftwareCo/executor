import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { ok, refused } from "../support/app-links.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Contribution, contributedApp, contributedSource } from "../support/contributed-app.ts";
import { Resource } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Contributed app requirements", (it) => {
  it.effect(scenarios.contributedAppRequirements.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const f = yield* contributedApp;
        const { api, actors, prefix, ids, member, readLinks } = f;
        yield* f.role(ids.admin, "member");
        const account = yield* f.connect(actors.member, "app", "shared", "Member's typed label");
        yield* refused(
          yield* f.start(actors.member, "app", "ordinary"),
          403,
          "OrganizationForbidden",
        );
        yield* refused(
          yield* f.get(actors.member, "app", "ordinary"),
          403,
          "OrganizationForbidden",
        );
        const choices = yield* f.get(actors.member, "app", "shared");
        yield* ok(choices);
        expect(choices.body).toMatchObject({
          canContribute: true,
          cardinality: "many",
          scope: "app",
        });
        const [own] = yield* readLinks(actors.member);
        expect(own).toMatchObject({
          linkedBy: { id: ids.member, name: member.name },
          canRemove: true,
        });
        expect((yield* readLinks(actors.owner))[0]?.canRemove).toBe(true);
        expect((yield* readLinks(actors.admin))[0]?.canRemove).toBe(false);
        yield* refused(
          yield* f.unlink(actors.admin, "shared", account),
          403,
          "OrganizationForbidden",
        );
        yield* refused(
          yield* f.link(actors.admin, "shared", account),
          403,
          "OrganizationForbidden",
        );
        const personal = yield* f.connect(actors.member, "user", "own", "Personal account");
        yield* refused(
          yield* f.link(actors.admin, "shared", personal),
          403,
          "OrganizationForbidden",
        );
        yield* refused(
          yield* api.request(actors.admin, "DELETE", `${prefix}/accounts/${account}`),
          403,
          "OrganizationForbidden",
        );
        yield* ok(yield* f.unlink(actors.member, "shared", account));
        const relink = yield* f.link(actors.member, "shared", account);
        expect(yield* body(Contribution, relink)).toMatchObject({
          linkedBy: { id: ids.member },
          canRemove: true,
        });
        yield* refused(
          yield* f.link(actors.member, "ordinary", account),
          403,
          "OrganizationForbidden",
        );

        yield* ok(
          yield* api.request(actors.member, "PATCH", `${prefix}/accounts/${account}`, {
            description: "A person typed this description",
          }),
        );
        yield* ok(
          yield* api.request(actors.member, "POST", `${prefix}/accounts/${account}/health`),
        );
        const [view] = yield* readLinks(actors.admin);
        expect(view).toMatchObject({
          account: {
            label: "Member's typed label",
            description: "A person typed this description",
          },
          health: { info: null, infoCheckedAt: null },
        });
        expect((yield* readLinks(actors.member))[0]?.health?.info).toEqual({
          email: "upstream@example.test",
        });
        expect((yield* readLinks(actors.owner))[0]?.health?.info).toEqual({
          email: "upstream@example.test",
        });
        const detail = yield* api.request(actors.admin, "GET", `${prefix}/accounts/${account}`);
        yield* refused(detail, 403, "OrganizationForbidden");
        yield* refused(
          yield* api.request(actors.admin, "POST", `${prefix}/accounts/${account}/health`),
          403,
          "OrganizationForbidden",
        );
        for (const endpoint of ["inventory", "resources"]) {
          const directory = yield* api.request(actors.admin, "GET", `${prefix}/${endpoint}`);
          const entries = yield* body(
            Schema.Struct({ accounts: Schema.Array(Schema.Unknown) }),
            directory,
          );
          expect(entries.accounts).not.toContainEqual(
            expect.objectContaining(
              endpoint === "resources"
                ? {
                    account: expect.objectContaining({
                      id: account,
                    }),
                  }
                : { id: account },
            ),
          );
        }
        yield* f.role(ids.admin, "admin");
        const [managed] = yield* readLinks(actors.admin);
        expect(managed).toMatchObject({
          health: { info: { email: "upstream@example.test" } },
        });
        yield* ok(yield* f.unlink(actors.owner, "shared", account));

        yield* refused(
          yield* f.link(actors.owner, "shared", account),
          403,
          "OrganizationForbidden",
        );
        yield* ok(yield* f.link(actors.member, "shared", account));
        yield* ok(yield* api.request(actors.member, "DELETE", `${prefix}/accounts/${account}`));
        expect(yield* readLinks()).toEqual([]);
        const ordinary = yield* f.connect(actors.owner, "app", "ordinary", "Ordinary account");
        yield* ok(
          yield* api.request(actors.owner, "POST", `${prefix}/accounts/${ordinary}/health`),
        );
        expect((yield* readLinks(actors.member))[0]).toMatchObject({
          requirement: "ordinary",
          account: { id: ordinary, label: "Ordinary account" },
          health: { info: null, infoCheckedAt: null },
        });
        expect((yield* readLinks(actors.owner))[0]?.health).toMatchObject({
          info: { email: "upstream@example.test" },
          infoCheckedAt: expect.any(String),
        });

        const held = yield* f.connect(actors.member, "user", "own", "Member's ordinary account");
        yield* refused(yield* f.link(actors.owner, "ordinary", held), 403, "OrganizationForbidden");
        yield* ok(yield* f.link(actors.member, "shared", held));
        yield* ok(yield* api.request(actors.member, "POST", `${prefix}/accounts/${held}/health`));
        const heldLinks = (yield* readLinks(actors.member)).filter(
          (link) => link.account.id === held,
        );
        expect(heldLinks.map((link) => link.requirement)).toEqual(["shared"]);
        expect(heldLinks.find((link) => link.requirement === "shared")?.health).toMatchObject({
          info: { email: "upstream@example.test" },
          infoCheckedAt: expect.any(String),
        });
        yield* refused(
          yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${ordinary}`),
          409,
          "AccountLinkedToApp",
        );
      }),
    ),
  );

  it.effect(scenarios.contributedAppConnections.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const f = yield* contributedApp;
        const { api, actors, path, prefix } = f;
        const started = yield* f.start(actors.member, "app", "shared");
        const pending = (yield* body(Resource, started)).id;
        const revision = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        yield* ok(
          yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: revision.revision,
            audience: { kind: "private" },
          }),
        );
        yield* refused(
          yield* f.submit(actors.member, pending, "No longer allowed"),
          403,
          "OrganizationForbidden",
        );
        const current = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        yield* ok(
          yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: current.revision,
            audience: { kind: "everyone" },
          }),
        );
        yield* ok(
          yield* api.request(actors.owner, "POST", `${path}/deploy`, {
            files: [
              {
                path: "index.ts",
                content: contributedSource.replace(
                  "service.many().contributed()",
                  "service.many()",
                ),
              },
              appsManifest,
            ],
          }),
        );
        yield* refused(
          yield* f.submit(actors.member, pending, "Opt-in was removed"),
          403,
          "OrganizationForbidden",
        );
        expect(yield* f.readLinks()).toEqual([]);
        const invalid = contributedSource
          .replace("app: { accounts: { shared:", "user: { accounts: { shared:")
          .replace(", user: { accounts: { own: service.many() } }", "");
        const rejected = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          files: [{ path: "index.ts", content: invalid }, appsManifest],
        });
        expect(rejected.status).not.toBe(200);
        expect(JSON.stringify(rejected.body)).toContain("must be in app.accounts");
        const malformed = contributedSource.replace(
          "service.many().contributed()",
          "Object.assign(service, { isContributed: true })",
        );
        const plain = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          files: [{ path: "index.ts", content: malformed }, appsManifest],
        });
        expect(plain.status).not.toBe(200);
        expect(JSON.stringify(plain.body)).toContain("must use provider.many().contributed()");
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/apps/${f.app.id}`)).status,
        ).toBe(200);
      }),
    ),
  );
});
