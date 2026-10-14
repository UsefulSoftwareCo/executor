import {
  connectionsPath,
  linkAccount,
  linkAccountResponse,
  linkedAccountIds,
} from "../support/app-accounts.ts";
/** Real hosted group checks cover linked accounts and current app authoring routes. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource, Inventory } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
import { Browser } from "../support/browser.ts";
import { openPrivateApp, waitForAppUrl } from "../support/app-pages.ts";
import { appsManifest } from "../support/apps-release.ts";
import { freeSeat } from "../support/seats.ts";

const Access = Schema.Struct({
  revision: Schema.String,
  canUse: Schema.Boolean,
  canManage: Schema.Boolean,
});
const Group = Schema.Struct({ id: Schema.String, revision: Schema.String });
const Groups = Schema.Struct({
  members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
});
const identitySource = `import {defineApp, query, object, router} from "apps";
export default defineApp({},{name:"Access fixture", tools: router({ identity:query({input:object({})},async()=>"allowed") })});`;
const arraySource = `import {defineApp, defineProvider, secrets, query, object, string, router} from "apps";
const service=defineProvider({name:"Group array fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export default defineApp({user: { accounts:{service:service.many()} }},async ctx=>({name:"Group array",tools: router({
  identity:query({input:object({})},async()=>ctx.user.accounts.service.map(account=>account.fields.token)),
})}));`;
const singleSource = arraySource
  .replace("service:service.many()", "service")
  .replace(
    "ctx.user.accounts.service.map(account=>account.fields.token)",
    "ctx.user.accounts.service.fields.token",
  );

const resourceFixture = Effect.gen(function* () {
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
        expect((yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app}`)).status).toBe(
          200,
        );
      for (const account of created.accounts)
        expect(
          (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`)).status,
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
  const members = yield* body(Groups, yield* api.request(actors.owner, "GET", `${prefix}/groups`));
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
  return { api, actors, prefix, suffix, created, sales, engineering };
});

/**
 * `actor` cannot link another person's personal accounts to the `service` requirement of the app
 * at `appPath`, and its calls never run with them: each link is refused as forbidden, and the call runs with the actor's own
 * links, of which there are none.
 */
const refusedForeignAccounts = (
  api: Effect.Success<typeof Api>,
  actor: Session,
  appPath: string,
  accounts: ReadonlyArray<string>,
  call: object,
) =>
  Effect.gen(function* () {
    for (const account of accounts) {
      const linked = yield* linkAccountResponse(actor, appPath, "service", account);
      expect(linked.status, JSON.stringify(linked.body)).toBe(403);
      expect(linked.body).toMatchObject({ _tag: "OrganizationForbidden" });
      expect(JSON.stringify(linked.body)).not.toContain(account);
    }
    expect(yield* linkedAccountIds(actor, appPath)).toEqual([]);
    const ran = yield* api.request(actor, "POST", `${appPath}/tools/call`, call);
    expect(ran.status, JSON.stringify(ran.body)).toBe(200);
    expect(ran.body).toEqual([]);
  });

const arrayFixture = Effect.gen(function* () {
  const { api, actors, prefix, suffix, created, sales } = yield* resourceFixture;
  const call = { tool: "identity", kind: "query", input: {} };
  const array = yield* body(
    App,
    yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `Array ${suffix}`,
      files: [
        { path: "index.ts", content: arraySource },
        {
          path: "ui/index.html",
          content:
            '<!doctype html><html><head><title>Account protected UI</title></head><body><h1>Account protected UI</h1><img src="probe.svg" alt="Probe"></body></html>',
        },
        {
          path: "ui/public/probe.svg",
          content: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
        },
        appsManifest,
      ],
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
    yield* api.request(
      actors.owner,
      "POST",
      connectionsPath(`${prefix}/apps/${array.id}`, "user", "service"),
      { destination: { kind: "personal" } },
    ),
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
    yield* api.request(
      actors.owner,
      "POST",
      connectionsPath(`${prefix}/apps/${array.id}`, "user", "service"),
      { destination: { kind: "shared", audience: { kind: "groups", groups: [sales.id] } } },
    ),
  );
  const team = yield* body(
    Resource,
    yield* api.request(actors.owner, "POST", `${prefix}/connections/${teamConnection.id}/submit`, {
      method: "key",
      label: "Sales fixture",
      fields: { token: "team" },
    }),
  );
  created.accounts.push(team.id);
  expect((yield* api.request(actors.member, "GET", `${prefix}/accounts/${team.id}`)).status).toBe(
    403,
  );
  expect(
    (yield* api.request(actors.admin, "GET", `${prefix}/accounts/${personal.id}`)).status,
  ).toBe(403);
  // Both connections linked their account for the owner, who cannot use the Sales account yet.
  const arrayPath = `${prefix}/apps/${array.id}`;
  expect(yield* linkedAccountIds(actors.owner, arrayPath)).toEqual([personal.id]);
  // An account the caller cannot use drops out of the linked set: it is never revealed or
  // used, and nothing replaces it.
  const narrowed = yield* api.request(actors.owner, "POST", `${arrayPath}/tools/call`, call);
  expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
  expect(narrowed.body).toEqual(["personal"]);
  // Another member can neither link the owner's personal account nor run with it.
  yield* refusedForeignAccounts(api, actors.admin, arrayPath, [personal.id], call);
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
  expect(yield* linkedAccountIds(actors.owner, arrayPath)).toEqual([personal.id, team.id]);
  return {
    api,
    actors,
    prefix,
    suffix,
    created,
    sales,
    array,
    personal,
    team,
    call,
  };
});

layer(HostedLive, { excludeTestServices: true })("Resource access", (it) => {
  it.effect(scenarios.resourceAccess.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, suffix, created, sales, engineering } = yield* resourceFixture;
        const deployment = yield* api.request(actors.member, "POST", `${prefix}/apps/deploy`, {
          name: `Private ${suffix}`,
          files: [{ path: "index.ts", content: identitySource }, appsManifest],
        });
        expect(deployment.status).toBe(200);
        const app = yield* body(App, deployment);
        created.apps.push(app.id);
        const call = { tool: "identity", kind: "query", input: {} };
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
        // The app list checks current membership with every app's policy, so an app shared with
        // everyone after a member is removed stays hidden from that member.
        const listed = (actor: Session) => api.request(actor, "GET", `${prefix}/apps`);
        const listedIds = (actor: Session) =>
          Effect.flatMap(listed(actor), (response) =>
            Effect.map(body(Schema.Array(App), response), (apps) => apps.map((item) => item.id)),
          );
        expect(yield* listedIds(actors.member)).not.toContain(app.id);
        const seat = yield* freeSeat;
        const grouped = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: grouped.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const removed = yield* listed(actors.member);
        expect(removed.status).toBe(403);
        expect(JSON.stringify(removed.body)).not.toContain(app.id);
        yield* seat.rejoin;
        expect(yield* listedIds(actors.member)).toContain(app.id);
      }),
    ),
  );
  it.effect(scenarios.arrayResourceAccess.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, sales, array, personal, team, call } = yield* arrayFixture;
        const browser = yield* Browser;
        const appUrl = new URL(yield* waitForAppUrl(actors.owner, `${prefix}/apps/${array.id}/ui`));
        yield* browser.login(actors.owner);
        yield* openPrivateApp(appUrl.href);
        yield* browser.use("Every linked account permits the UI", (page) =>
          page.getByRole("heading", { name: "Account protected UI" }).waitFor(),
        );
        const assetUrl = yield* browser.use("Locate the account-protected asset", (page) =>
          page.evaluate(() => document.querySelector("img")?.src ?? ""),
        );
        const validator = yield* browser.use("Warm the account-protected asset", (page) =>
          page
            .context()
            .request.get(assetUrl)
            .then((response) => {
              expect(response.status()).toBe(200);
              return response.headers()["etag"];
            }),
        );
        if (validator === undefined)
          return yield* Effect.die("Account-protected asset has no ETag");
        const currentTeamAccess = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${prefix}/accounts/${team.id}/access`),
        );
        const restrictedTeam = yield* body(
          Access,
          yield* api.request(actors.owner, "PATCH", `${prefix}/accounts/${team.id}/access`, {
            revision: currentTeamAccess.revision,
            audience: { kind: "groups", groups: [sales.id] },
          }),
        );
        expect(
          (yield* browser.use(
            "Revoking one linked account leaves the page the accounts still allowed",
            (page) => page.context().request.get(appUrl.href),
          )).status(),
        ).toBe(200);
        const narrowed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${array.id}/tools/call`,
          call,
        );
        expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
        expect(narrowed.body).toEqual(["personal"]);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/accounts/${team.id}/access`, {
            revision: restrictedTeam.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        expect(
          (yield* browser.use("Restored account permission revalidates the same asset", (page) =>
            page.context().request.get(assetUrl, { headers: { "if-none-match": validator } }),
          )).status(),
        ).toBe(304);
        // An administrator opens the app with only the administrator's own links, and cannot link
        // another person's personal account.
        yield* browser.login(actors.admin);
        yield* openPrivateApp(appUrl.href);
        yield* refusedForeignAccounts(
          api,
          actors.admin,
          `${prefix}/apps/${array.id}`,
          [personal.id],
          call,
        );
      }),
    ),
  );
  it.effect(scenarios.arrayResourceDeletion.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, suffix, created, array, personal, team, call } =
          yield* arrayFixture;
        const browser = yield* Browser;
        yield* browser.login(actors.admin);
        const workspace = yield* body(
          Schema.Struct({
            canEdit: Schema.Boolean,
            revision: Schema.Struct({ commit: Schema.String }),
          }),
          yield* api.request(actors.admin, "GET", `${prefix}/apps/${array.id}/workspace`),
        );
        expect(workspace.canEdit).toBe(true);
        expect(
          (yield* api.request(actors.admin, "POST", `${prefix}/apps/${array.id}/commits`, {
            expected: workspace.revision.commit,
            files: [{ path: "index.ts", content: arraySource }, appsManifest],
            message: "Source editing is independent of personal account links",
          })).status,
        ).toBe(200);
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
            files: [{ path: "index.ts", content: singleSource }, appsManifest],
          }),
        );
        created.apps.push(single.id);
        yield* linkAccount(actors.owner, `${prefix}/apps/${single.id}`, "service", personal.id);
        expect(
          (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${personal.id}`)).status,
        ).toBe(200);
        created.accounts.splice(created.accounts.indexOf(personal.id), 1);
        // Renaming above changed the app origin; its old session cannot transfer.
        yield* linkAccount(actors.admin, `${prefix}/apps/${array.id}`, "service", team.id);
        const renamedUrl = new URL(
          yield* waitForAppUrl(actors.admin, `${prefix}/apps/${array.id}/ui`),
        );
        yield* openPrivateApp(renamedUrl.href);
        const remainingAsset = yield* browser.use(
          "Locate the renamed app's retained asset",
          (page) => page.evaluate(() => document.querySelector("img")?.src ?? ""),
        );
        expect(
          (yield* browser.use("The UI allows the remaining shared array account", (page) =>
            page.context().request.get(remainingAsset),
          )).status(),
        ).toBe(200);
        // Deleting an account removes its links from every app.
        expect(yield* linkedAccountIds(actors.owner, `${prefix}/apps/${array.id}`)).toEqual([
          team.id,
        ]);
        expect(yield* linkedAccountIds(actors.owner, `${prefix}/apps/${single.id}`)).toEqual([]);
        expect(
          (yield* api.request(actors.admin, "POST", `${prefix}/apps/${array.id}/tools/call`, call))
            .body,
        ).toEqual(["team"]);
        const inventory = yield* body(
          Inventory,
          yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
        );
        expect(inventory.accounts.some((item) => item.id === personal.id)).toBe(false);
        expect(inventory.links.some((link) => link.account === personal.id)).toBe(false);
        expect(
          (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${team.id}`)).status,
        ).toBe(200);
        created.accounts.splice(created.accounts.indexOf(team.id), 1);
        expect(yield* linkedAccountIds(actors.owner, `${prefix}/apps/${array.id}`)).toEqual([]);
        expect(yield* linkedAccountIds(actors.admin, `${prefix}/apps/${array.id}`)).toEqual([]);
      }),
    ),
  );
  it.effect(scenarios.groupAuthoring.title, (context) =>
    withHostedCase(
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
          yield* api.request(actors.member, "POST", `${prefix}/apps`, {
            name: `Member draft ${suffix}`,
            files: [{ path: "index.ts", content: identitySource }, appsManifest],
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
          yield* api.request(actors.owner, "POST", `${prefix}/apps`, {
            name: `Owner draft ${suffix}`,
            files: [{ path: "index.ts", content: identitySource }, appsManifest],
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
