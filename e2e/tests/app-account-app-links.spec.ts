/**
 * An app's own requirements are filled by the accounts people who can edit it link for everyone,
 * for every caller; each caller's user requirements by their own links. Members use an app-linked
 * account through the app without access to it. They can list the app links, without the upstream
 * identity their checks reported, but cannot read a requirement's choices, change the links or
 * override them.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { appsManifest } from "../support/apps-release.ts";
import {
  accountLinks,
  linkAccount,
  linkAccountResponse,
  linkedAccountIds,
} from "../support/app-accounts.ts";
import {
  LinkRequirement,
  appLinksFixture,
  keyProvider,
  ok,
  okBody,
  refused,
} from "../support/app-links.ts";
import { scenarios } from "../test-plan.ts";

/**
 * An app with a plain and a many() app requirement of one provider, whose check reports the
 * account's token as its upstream username, and a user requirement.
 */
const source = `import { defineApp, defineProvider, secrets, query, object, string, router, type QueryContext } from "apps";
const team = defineProvider({
  name: "App link team fixture",
  auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) },
  async health({ account }) { return { accountInfo: { username: account.fields.token } }; },
});
const mail = ${keyProvider("App link mail fixture")};
const requirements = { app: { accounts: { team, extra: team.many() } }, user: { accounts: { mail } } };
const who = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) => ({
  team: ctx.app.accounts.team.id,
  token: ctx.app.accounts.team.fields.token,
  extra: ctx.app.accounts.extra.map((account) => account.id),
  mail: ctx.user.accounts.mail.id,
}));
export default defineApp(requirements, async () => ({ tools: router({ who }) }));`;
const Who = Schema.Struct({
  team: Schema.String,
  token: Schema.String,
  extra: Schema.Array(Schema.String),
  mail: Schema.String,
});
/** An app whose one key requirement is in `scope`. */
const scopedKeyApp = (
  scope: "app" | "user",
) => `import { defineApp, defineProvider, secrets, object, string, router } from "apps";
const service = ${keyProvider("App link connection key fixture")};
export default defineApp({ ${scope}: { accounts: { service } } }, async () => ({ tools: router({}) }));`;
/** An app whose one OAuth requirement, discovered at `issuer`, is in `scope`. */
const scopedOAuthApp = (
  issuer: string,
  scope: "app" | "user",
) => `import { defineApp, defineProvider, oauth2, router } from "apps";
const service = defineProvider({ name: "App link connection OAuth fixture", auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer}/mcp`)} }) } });
export default defineApp({ ${scope}: { accounts: { service } } }, async () => ({ tools: router({}) }));`;
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const LinkedRefusal = Schema.Struct({ _tag: Schema.String, apps: Schema.Array(Schema.String) });

layer(HostedLive, { excludeTestServices: true })("App account app links", (it) => {
  it.effect(scenarios.hostedAppLinks.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([{ path: "index.ts", content: source }]);
        const { api, actors, prefix, app, path, connect, link, unlink, links, get } = fixture;
        const who = (actor: typeof actors.member) =>
          fixture.call(actor, "who").pipe(
            Effect.tap(ok),
            Effect.flatMap((response) => body(Who, response)),
          );
        const pairs = (actor: Session = actors.owner) =>
          Effect.map(links(actor), (read) =>
            read.map((item) => [item.requirement, item.account.id] as const),
          );
        // The member links their own account for the user requirement. With no app link, the
        // app requirement refuses every call and names who can fix it.
        const mail = yield* connect(actors.member, "user", "mail", "member-mail");
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([mail]);
        const unlinked = yield* fixture.call(actors.member, "who");
        expect(yield* refused(unlinked, 409, "AccountRequired")).toMatchObject({
          slot: "team",
          scope: "app",
        });
        expect(unlinked.body).toMatchObject({
          message:
            "This app needs its own “team” account, which someone who can edit the app links for everyone who uses it. None is linked yet.",
          recovery: {
            action: "Ask someone who can edit this app to link an account on its Accounts tab.",
          },
        });
        expect(yield* links(actors.member)).toEqual([]);

        // A manager connects the team account for the app requirement, which links it for
        // everyone. The member's calls use it through the app, though the account is the owner's
        // personal one.
        const first = yield* connect(actors.owner, "app", "team", "team-first");
        expect(yield* pairs()).toEqual([["team", first]]);
        expect(yield* who(actors.member)).toEqual({
          team: first,
          token: "team-first",
          extra: [],
          mail,
        });
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/accounts/${first}`)).status,
        ).not.toBe(200);
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([mail]);

        // Once the account's check reports its upstream identity, a manager reads it on the app
        // link; a member lists the same link with its checks but without that identity.
        yield* ok(yield* api.request(actors.owner, "POST", `${prefix}/accounts/${first}/health`));
        const [managed] = yield* links(actors.owner);
        expect(managed?.health?.info).toMatchObject({ username: "team-first" });
        expect(managed?.health?.infoCheckedAt).toEqual(expect.any(String));
        const listed = yield* links(actors.member);
        expect(listed.map((item) => [item.requirement, item.account.id])).toEqual([
          ["team", first],
        ]);
        expect(listed[0]?.health).toMatchObject({ info: null, infoCheckedAt: null });

        // Connecting another account for the plain requirement replaces its link; the replaced
        // account stays saved. Connecting one for many() adds it.
        const own = yield* connect(actors.owner, "app", "team", "team-own");
        const shared = yield* connect(actors.owner, "app", "extra", "team-shared", {
          kind: "shared",
          audience: { kind: "everyone" },
        });
        const linked = yield* pairs();
        expect(linked).toHaveLength(2);
        expect(linked).toEqual(
          expect.arrayContaining([
            ["team", own],
            ["extra", shared],
          ]),
        );
        expect(yield* who(actors.member)).toEqual({
          team: own,
          token: "team-own",
          extra: [shared],
          mail,
        });

        // Members can list the app links but not read a requirement's choices, change the links
        // or connect for an app requirement. They cannot supply an app account either: linking
        // the shared team account for themselves fails, since the app requirement is not one of
        // theirs and their requirement takes another provider, and a call naming accounts still
        // runs with the app links.
        yield* refused(yield* get(actors.member, "app", "team"), 403, "OrganizationForbidden");
        expect((yield* link(actors.member, "team", shared)).status).toBe(403);
        expect((yield* unlink(actors.member, "team", own)).status).toBe(403);
        expect(
          (yield* fixture.start(actors.member, "app", "team", { kind: "personal" })).status,
        ).toBe(403);
        expect(
          yield* refused(
            yield* linkAccountResponse(actors.member, path, "team", shared),
            422,
            "RequirementMismatch",
          ),
        ).toMatchObject({ requirement: "team", scope: "user", reason: "requirement" });
        expect(
          yield* refused(
            yield* linkAccountResponse(actors.member, path, "mail", shared),
            422,
            "RequirementMismatch",
          ),
        ).toMatchObject({ requirement: "mail", scope: "user", reason: "provider" });
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([mail]);
        const overridden = yield* api.request(actors.member, "POST", `${path}/tools/call`, {
          tool: "who",
          kind: "query",
          input: {},
          accounts: { team: shared },
        });
        expect(overridden.status, JSON.stringify(overridden.body)).toBe(200);
        expect(yield* body(Who, overridden)).toMatchObject({ team: own });
        yield* ok(yield* link(actors.owner, "team", first));
        yield* ok(yield* link(actors.owner, "extra", own));
        expect(yield* who(actors.member)).toEqual({
          team: first,
          token: "team-first",
          extra: [shared, own],
          mail,
        });

        // A manager reads each requirement's linked accounts first, in link order, then the
        // other accounts of its provider they could link.
        const team = yield* okBody(LinkRequirement, yield* get(actors.owner, "app", "team"));
        expect(team).toMatchObject({ requirement: "team", scope: "app", cardinality: "one" });
        expect(team.accounts[0]).toMatchObject({ account: { id: first }, linked: true });
        expect(team.accounts.slice(1).every((entry) => !entry.linked)).toBe(true);
        expect(team.accounts.map((entry) => entry.account.id)).toEqual(
          expect.arrayContaining([own, shared]),
        );
        const extra = yield* okBody(LinkRequirement, yield* get(actors.owner, "app", "extra"));
        expect(extra).toMatchObject({
          requirement: "extra",
          scope: "app",
          provider: team.provider,
          cardinality: "many",
        });
        expect(
          extra.accounts.filter((entry) => entry.linked).map((entry) => entry.account.id),
        ).toEqual([shared, own]);
        expect(extra.accounts.slice(0, 2).every((entry) => entry.linked)).toBe(true);
        expect(extra.accounts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              account: expect.objectContaining({ id: first }),
              linked: false,
            }),
          ]),
        );

        // App links take only app requirements, with an account of their provider the manager
        // can use.
        expect(
          yield* refused(yield* link(actors.owner, "mail", first), 422, "RequirementMismatch"),
        ).toMatchObject({ requirement: "mail", scope: "app", reason: "requirement" });
        expect(
          yield* refused(yield* link(actors.owner, "missing", first), 422, "RequirementMismatch"),
        ).toMatchObject({ requirement: "missing", scope: "app", reason: "requirement" });
        yield* refused(yield* get(actors.owner, "app", "mail"), 422, "RequirementMismatch");
        const ownerMail = yield* connect(actors.owner, "user", "mail", "owner-mail");
        expect(
          yield* refused(yield* link(actors.owner, "team", ownerMail), 422, "RequirementMismatch"),
        ).toMatchObject({ requirement: "team", scope: "app", reason: "provider" });
        // The admin manages the app but cannot use the owner's personal account.
        expect((yield* link(actors.admin, "extra", first)).status).toBe(403);

        // An account linked for everyone cannot be deleted until it is unlinked.
        const deleting = yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${first}`);
        expect(deleting.status, JSON.stringify(deleting.body)).toBe(409);
        expect(yield* body(LinkedRefusal, deleting)).toEqual({
          _tag: "AccountLinkedToApp",
          apps: [app.id],
        });

        // Unlinking keeps the account; calls need an app link again, and linking it again
        // restores them.
        expect(yield* ok(yield* unlink(actors.owner, "team", first))).toEqual({
          requirement: "team",
          account: first,
        });
        expect(
          yield* refused(yield* fixture.call(actors.member, "who"), 409, "AccountRequired"),
        ).toMatchObject({ slot: "team", scope: "app" });
        expect(
          (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${first}`)).status,
        ).toBe(200);
        yield* ok(yield* link(actors.owner, "team", first));
        expect(yield* who(actors.member)).toMatchObject({ team: first, mail });
        // The owner's own calls use the same app links and their own user link.
        yield* linkAccount(actors.owner, path, "mail", ownerMail);
        expect(yield* who(actors.owner)).toMatchObject({ team: first, mail: ownerMail });
      }),
    ),
  );
  it.effect(scenarios.hostedAppLinkConnections.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([
          { path: "index.ts", content: scopedKeyApp("app") },
        ]);
        const { api, actors, prefix, ids, start, submit, link, links } = fixture;
        // The admin manages the app but is outside the only group that may use a shared account.
        const group = yield* fixture.group([ids.member]);
        const inGroup = { kind: "shared", audience: { kind: "groups", groups: [group.id] } };
        // Account labels the actor's inventory lists. Cloud sets up each manager's own Executor key
        // account in the background, so the inventory may gain that account at any time; the
        // refused account is recognised by the label it was submitted with.
        const inventoryLabels = (actor: typeof actors.admin) =>
          api.request(actor, "GET", `${prefix}/inventory`).pipe(
            Effect.flatMap((response) =>
              body(
                Schema.Struct({ accounts: Schema.Array(Schema.Struct({ label: Schema.String })) }),
                response,
              ),
            ),
            Effect.map((read) => read.accounts.map((account) => account.label)),
          );
        expect(yield* inventoryLabels(actors.admin)).not.toContain("synthetic-group-key");
        const started = yield* start(actors.admin, "app", "service", inGroup);
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const connection = (yield* body(Resource, started)).id;
        const denied = yield* submit(actors.admin, connection, "synthetic-group-key");
        yield* refused(denied, 403, "AccountConnectionRefused");
        // The refusal rolls the account save back: nothing is linked or saved.
        expect(yield* links()).toEqual([]);
        expect(yield* inventoryLabels(actors.admin)).not.toContain("synthetic-group-key");

        // The admin may link for everyone only an account they can use; a member of the group
        // may connect it only for their own links, and the admin still cannot link that shared
        // account for everyone by its ID.
        const memberPath = yield* fixture.another(scopedKeyApp("user"));
        const memberStarted = yield* start(actors.member, "user", "service", inGroup, memberPath);
        expect(memberStarted.status, JSON.stringify(memberStarted.body)).toBe(200);
        const groupAccount = yield* submit(
          actors.member,
          (yield* body(Resource, memberStarted)).id,
          "synthetic-member-group-key",
        ).pipe(
          Effect.tap(ok),
          Effect.flatMap((response) => body(Resource, response)),
          Effect.map((account) => account.id),
        );
        yield* fixture.saved(actors.member, groupAccount);
        yield* refused(
          yield* link(actors.admin, "service", groupAccount),
          403,
          "OrganizationForbidden",
        );
        expect(yield* links()).toEqual([]);
        // Once the admin joins the group, the same account links.
        yield* group.set([ids.member, ids.admin]);
        yield* ok(yield* link(actors.admin, "service", groupAccount));
        expect((yield* links()).map((item) => item.account.id)).toEqual([groupAccount]);

        // A connection completes only in the scope it started in: a redeploy that moves the
        // requirement to the other scope refuses it, both ways.
        const drift = (from: "app" | "user", to: "app" | "user") =>
          Effect.gen(function* () {
            const driftPath = yield* fixture.another(scopedKeyApp(from));
            const pending = yield* start(
              actors.owner,
              from,
              "service",
              { kind: "personal" },
              driftPath,
            );
            expect(pending.status, JSON.stringify(pending.body)).toBe(200);
            const redeployed = yield* api.request(actors.owner, "POST", `${driftPath}/deploy`, {
              files: [{ path: "index.ts", content: scopedKeyApp(to) }, appsManifest],
            });
            expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
            const changed = yield* submit(
              actors.owner,
              (yield* body(Resource, pending)).id,
              "synthetic-drift",
            );
            yield* refused(changed, 409, "AccountConnectionTargetChanged");
            expect(yield* accountLinks(actors.owner, driftPath, "app")).toEqual([]);
            expect(yield* accountLinks(actors.owner, driftPath, "user")).toEqual([]);
          });
        yield* drift("user", "app");
        yield* drift("app", "user");
      }),
    ),
  );
  it.effect(scenarios.hostedAppLinkOAuthConnections.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const fixture = yield* appLinksFixture([
          { path: "index.ts", content: scopedOAuthApp(issuer.origin, "app") },
        ]);
        const { api, actors, prefix, ids, start, links } = fixture;
        const signIn = (actor: Session, connection: string) =>
          Effect.gen(function* () {
            const started = yield* api.request(
              actor,
              "POST",
              `${prefix}/connections/${connection}/oauth/start`,
              { method: "oauth", label: "App link OAuth" },
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const url = (yield* body(SignIn, started)).authorizationUrl;
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const consent = yield* HttpClient.withScope(http).get(url);
                expect(consent.status).toBe(302);
                const location = consent.headers.location;
                if (location === undefined) return yield* Effect.die(new Error("No callback"));
                return location;
              }),
            ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
          });
        const complete = (actor: Session, connection: string, callbackUrl: string) =>
          api.request(actor, "POST", `${prefix}/connections/${connection}/oauth/complete`, {
            callbackUrl,
          });
        const state = (actor: Session, connection: string) =>
          api.request(actor, "GET", `${prefix}/connections/${connection}`).pipe(
            Effect.flatMap((response) => body(Schema.Struct({ state: Schema.Unknown }), response)),
            Effect.map((read) => read.state),
          );
        const group = yield* fixture.group([ids.member]);
        const inGroup = { kind: "shared", audience: { kind: "groups", groups: [group.id] } };
        // The admin signs in for a group-shared account they cannot use: the code is exchanged,
        // then the link is refused and the refusal is recorded on the connection.
        const started = yield* start(actors.admin, "app", "service", inGroup);
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const connection = (yield* body(Resource, started)).id;
        const callback = yield* signIn(actors.admin, connection);
        const exchanges = (yield* issuer.metrics).tokenExchanges;
        yield* refused(
          yield* complete(actors.admin, connection, callback),
          403,
          "AccountConnectionRefused",
        );
        expect((yield* issuer.metrics).tokenExchanges).toBe(exchanges + 1);
        expect(yield* state(actors.admin, connection)).toMatchObject({
          status: "pending",
          failure: { error: { _tag: "AccountConnectionRefused", requirement: "service" } },
        });
        expect(yield* links()).toEqual([]);
        // Once the admin joins the group, a new sign-in clears the failure and links the account.
        yield* group.set([ids.member, ids.admin]);
        const retry = yield* signIn(actors.admin, connection);
        expect(yield* state(actors.admin, connection)).toEqual({ status: "pending" });
        yield* ok(yield* complete(actors.admin, connection, retry));
        expect(yield* state(actors.admin, connection)).toMatchObject({ status: "completed" });
        const linked = yield* links();
        expect(linked.map((item) => item.requirement)).toEqual(["service"]);
        yield* fixture.saved(actors.admin, linked[0]?.account.id ?? "missing");

        // A requirement that changes scope between sign-in and its callback refuses the
        // completion, and reading the connection names the change, as it does for a changed
        // provider.
        const driftPath = yield* fixture.another(scopedOAuthApp(issuer.origin, "user"));
        const pending = yield* start(
          actors.member,
          "user",
          "service",
          { kind: "personal" },
          driftPath,
        );
        expect(pending.status, JSON.stringify(pending.body)).toBe(200);
        const drift = (yield* body(Resource, pending)).id;
        const driftCallback = yield* signIn(actors.member, drift);
        expect(
          (yield* api.request(actors.owner, "POST", `${driftPath}/deploy`, {
            files: [
              { path: "index.ts", content: scopedOAuthApp(issuer.origin, "app") },
              appsManifest,
            ],
          })).status,
        ).toBe(200);
        yield* refused(
          yield* complete(actors.member, drift, driftCallback),
          409,
          "AccountConnectionTargetChanged",
        );
        expect(
          yield* refused(
            yield* api.request(actors.member, "GET", `${prefix}/connections/${drift}`),
            409,
            "AccountConnectionTargetChanged",
          ),
        ).toMatchObject({ requirement: "service" });
        expect(yield* linkedAccountIds(actors.member, driftPath)).toEqual([]);
      }),
    ),
  );
  it.effect(scenarios.hostedAppRequirementScopes.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // A requirement name is used in one scope only, so the deploy is refused.
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Scope clash ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, secrets, object, string, router } from "apps";
const service = ${keyProvider("Scope clash fixture")};
export default defineApp({ app: { accounts: { service } }, user: { accounts: { service } } }, async () => ({ tools: router({}) }));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).not.toBe(200);
        expect(JSON.stringify(deployed.body)).toContain(
          "is declared as both an app and a user account",
        );
      }),
    ),
  );
});
