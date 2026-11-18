/**
 * An app's own requirements are filled by the accounts people who can edit it link for everyone,
 * for every caller; each caller's user requirements by their own links. Members use an app-linked
 * account through the app without access to it. They can list the app links, without the upstream
 * identity their checks reported, but cannot read a requirement's choices, change the links or
 * override them.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomBytes, randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Telemetry } from "../support/evidence.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { appsManifest } from "../support/apps-release.ts";
import {
  accountLinks,
  linkAccount,
  linkAccountResponse,
  linkedAccountIds,
  requirementPath,
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
const teamProvider = `defineProvider({
  name: "App link team fixture",
  auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) },
  async health({ account }) { return { accountInfo: { username: account.fields.token } }; },
})`;
const source = `import { defineApp, defineProvider, secrets, query, object, string, router, type QueryContext } from "apps";
const team = ${teamProvider};
const mail = ${keyProvider("App link mail fixture")};
const requirements = { app: { accounts: { team, extra: team.many() } }, user: { accounts: { mail } } };
const who = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) => ({
  team: ctx.app.accounts.team.id,
  token: ctx.app.accounts.team.fields.token,
  extra: ctx.app.accounts.extra.map((account) => account.id),
  mail: ctx.user.accounts.mail.id,
}));
export default defineApp(requirements, async () => ({ tools: router({ who }) }));`;
/** Another app whose user requirement takes the team provider, for a member's own team account. */
const teamUserSource = `import { defineApp, defineProvider, secrets, object, string, router } from "apps";
const team = ${teamProvider};
export default defineApp({ user: { accounts: { team } } }, async () => ({ tools: router({}) }));`;
const Who = Schema.Struct({
  team: Schema.String,
  token: Schema.String,
  extra: Schema.Array(Schema.String),
  mail: Schema.String,
});
/** Another app whose one app requirement takes the team provider, reporting the account it runs with. */
const teamAppSource = `import { defineApp, defineProvider, secrets, query, object, string, router, type QueryContext } from "apps";
const team = ${teamProvider};
const requirements = { app: { accounts: { team } } };
const who = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) => ({
  team: ctx.app.accounts.team.id,
  token: ctx.app.accounts.team.fields.token,
}));
export default defineApp(requirements, async () => ({ tools: router({ who }) }));`;
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
const TeamWho = Schema.Struct({ team: Schema.String, token: Schema.String });
const SessionIdentity = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });
const Memberships = Schema.Struct({
  members: Schema.Array(Schema.Struct({ ...Resource.fields, ...SessionIdentity.fields })),
});
const LogRecords = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        body: Schema.String,
        attributes: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
);
/** The audit attributes of the one `security.audit` record for `action` in a trace's logs. */
const auditOf = (logs: string, action: string) => {
  const records = Schema.decodeUnknownSync(LogRecords)(logs).data.filter(
    (record) => record.body === "security.audit" && record.attributes["audit.action"] === action,
  );
  expect(records, `one ${action} record`).toHaveLength(1);
  const attributes = records[0]?.attributes ?? {};
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith("audit.")));
};
const traced = () => {
  const traceId = randomBytes(16).toString("hex");
  return { traceId, traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01` };
};
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
        const spare = yield* connect(actors.owner, "app", "extra", "team-spare");
        const linked = yield* pairs();
        expect(linked).toHaveLength(2);
        expect(linked).toEqual(
          expect.arrayContaining([
            ["team", own],
            ["extra", spare],
          ]),
        );
        expect(yield* who(actors.member)).toEqual({
          team: own,
          token: "team-own",
          extra: [spare],
          mail,
        });

        // Members can list the app links but not read a requirement's choices, change the links
        // or connect for an app requirement. They cannot link a manager's account for themselves,
        // since only its owner may use it. They cannot supply an app account either: linking
        // their own team account for themselves fails, since the app requirement is not one of
        // theirs and their requirement takes another provider, and a call naming accounts still
        // runs with the app links.
        const teamPath = yield* fixture.another(teamUserSource);
        const memberStarted = yield* fixture.start(actors.member, "user", "team", teamPath);
        expect(memberStarted.status, JSON.stringify(memberStarted.body)).toBe(200);
        const memberTeam = (yield* okBody(
          Resource,
          yield* fixture.submit(
            actors.member,
            (yield* body(Resource, memberStarted)).id,
            "member-team",
          ),
        )).id;
        yield* fixture.saved(actors.member, memberTeam);
        yield* refused(yield* get(actors.member, "app", "team"), 403, "OrganizationForbidden");
        expect((yield* link(actors.member, "team", memberTeam)).status).toBe(403);
        expect((yield* unlink(actors.member, "team", own)).status).toBe(403);
        expect((yield* fixture.start(actors.member, "app", "team")).status).toBe(403);
        yield* refused(
          yield* linkAccountResponse(actors.member, path, "team", spare),
          403,
          "OrganizationForbidden",
        );
        expect(
          yield* refused(
            yield* linkAccountResponse(actors.member, path, "team", memberTeam),
            422,
            "RequirementMismatch",
          ),
        ).toMatchObject({ requirement: "team", scope: "user", reason: "requirement" });
        expect(
          yield* refused(
            yield* linkAccountResponse(actors.member, path, "mail", memberTeam),
            422,
            "RequirementMismatch",
          ),
        ).toMatchObject({ requirement: "mail", scope: "user", reason: "provider" });
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([mail]);
        const overridden = yield* api.request(actors.member, "POST", `${path}/tools/call`, {
          tool: "who",
          kind: "query",
          input: {},
          accounts: { team: memberTeam },
        });
        expect(overridden.status, JSON.stringify(overridden.body)).toBe(200);
        expect(yield* body(Who, overridden)).toMatchObject({ team: own });
        yield* ok(yield* link(actors.owner, "team", first));
        yield* ok(yield* link(actors.owner, "extra", own));
        expect(yield* who(actors.member)).toEqual({
          team: first,
          token: "team-first",
          extra: [spare, own],
          mail,
        });

        // A manager reads each requirement's linked accounts first, in link order, then the
        // other accounts of its provider they could link.
        const team = yield* okBody(LinkRequirement, yield* get(actors.owner, "app", "team"));
        expect(team).toMatchObject({ requirement: "team", scope: "app", cardinality: "one" });
        expect(team.accounts[0]).toMatchObject({ account: { id: first }, linked: true });
        expect(team.accounts.slice(1).every((entry) => !entry.linked)).toBe(true);
        expect(team.accounts.map((entry) => entry.account.id)).toEqual(
          expect.arrayContaining([own, spare]),
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
        ).toEqual([spare, own]);
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
        // The admin manages the app but does not own the owner's personal account. It is already
        // linked here for everyone, so the admin may link it to another requirement of the app, as
        // the app already runs with it; they still cannot read the account itself.
        yield* ok(yield* link(actors.admin, "extra", first));
        yield* ok(yield* unlink(actors.admin, "extra", first));

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
        const { api, actors, start, submit, link, links } = fixture;
        // A member connects an account from another app for their own links. It is theirs alone,
        // so neither the admin nor the owner, who both manage this app but cannot use it, can link
        // it for everyone by its ID.
        const memberPath = yield* fixture.another(scopedKeyApp("user"));
        const memberStarted = yield* start(actors.member, "user", "service", memberPath);
        expect(memberStarted.status, JSON.stringify(memberStarted.body)).toBe(200);
        const memberAccount = yield* submit(
          actors.member,
          (yield* body(Resource, memberStarted)).id,
          "synthetic-member-key",
        ).pipe(
          Effect.tap(ok),
          Effect.flatMap((response) => body(Resource, response)),
          Effect.map((account) => account.id),
        );
        yield* fixture.saved(actors.member, memberAccount);
        expect(yield* accountLinks(actors.member, memberPath, "user")).toEqual([
          ["service", memberAccount],
        ]);
        for (const manager of [actors.admin, actors.owner])
          yield* refused(
            yield* link(manager, "service", memberAccount),
            403,
            "OrganizationForbidden",
          );
        expect(yield* links()).toEqual([]);

        // A connection completes only in the scope it started in: a redeploy that moves the
        // requirement to the other scope refuses it, both ways.
        const drift = (from: "app" | "user", to: "app" | "user") =>
          Effect.gen(function* () {
            const driftPath = yield* fixture.another(scopedKeyApp(from));
            const pending = yield* start(actors.owner, from, "service", driftPath);
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
          { path: "index.ts", content: scopedOAuthApp(issuer.origin, "user") },
        ]);
        const { api, actors, prefix, path, start } = fixture;
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
        // A requirement that changes scope between sign-in and its callback refuses the
        // completion, and reading the connection names the change, as it does for a changed
        // provider.
        const pending = yield* start(actors.member, "user", "service");
        expect(pending.status, JSON.stringify(pending.body)).toBe(200);
        const connection = (yield* body(Resource, pending)).id;
        const callback = yield* signIn(actors.member, connection);
        const deploy = (scope: "app" | "user") =>
          api
            .request(actors.owner, "POST", `${path}/deploy`, {
              files: [
                { path: "index.ts", content: scopedOAuthApp(issuer.origin, scope) },
                appsManifest,
              ],
            })
            .pipe(Effect.tap(ok));
        yield* deploy("app");
        yield* refused(
          yield* complete(actors.member, connection, callback),
          409,
          "AccountConnectionTargetChanged",
        );
        expect(
          yield* refused(
            yield* api.request(actors.member, "GET", `${prefix}/connections/${connection}`),
            409,
            "AccountConnectionTargetChanged",
          ),
        ).toMatchObject({ requirement: "service" });
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([]);
        // Once the requirement is the member's again, a new sign-in clears the failure and links
        // the account for them.
        yield* deploy("user");
        const retry = yield* signIn(actors.member, connection);
        expect(yield* state(actors.member, connection)).toEqual({ status: "pending" });
        yield* ok(yield* complete(actors.member, connection, retry));
        expect(yield* state(actors.member, connection)).toMatchObject({ status: "completed" });
        const linked = yield* linkedAccountIds(actors.member, path);
        expect(linked).toHaveLength(1);
        yield* fixture.saved(actors.member, linked[0] ?? "missing");
      }),
    ),
  );
  it.effect(scenarios.hostedAppLinkReuse.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([{ path: "index.ts", content: source }]);
        const { api, actors, prefix, connect, start, submit } = fixture;
        const appLink = (actor: Session, appPath: string, account: string) =>
          linkAccountResponse(actor, appPath, "team", account, "app");
        const appUnlink = (actor: Session, appPath: string, account: string) =>
          api.request(
            actor,
            "DELETE",
            `${appPath}/accounts/app/team/${encodeURIComponent(account)}`,
          );
        const choices = (actor: Session, appPath: string) =>
          api.request(actor, "GET", `${appPath}/accounts/app/team`).pipe(
            Effect.flatMap((response) => okBody(LinkRequirement, response)),
            Effect.map((read) => read.accounts.map((entry) => [entry.account.id, entry.linked])),
          );
        const who = (actor: Session, appPath: string) =>
          api
            .request(actor, "POST", `${appPath}/tools/call`, {
              tool: "who",
              kind: "query",
              input: {},
            })
            .pipe(
              Effect.flatMap((response) =>
                okBody(Schema.Struct({ team: Schema.String }), response),
              ),
            );

        // The owner links their own team account for everyone to the fixture's app. A second app
        // the admin can edit takes the same provider; nothing fills its requirement yet.
        const shared = yield* connect(actors.owner, "app", "team", "team-shared");
        const second = yield* fixture.another(
          teamAppSource.replace(
            "accounts: { team }",
            "accounts: { team, privateTeam: team.many() }",
          ),
        );
        yield* refused(
          yield* api.request(actors.member, "POST", `${second}/tools/call`, {
            tool: "who",
            kind: "query",
            input: {},
          }),
          409,
          "AccountRequired",
        );

        // The same admin's credential narrowed to the target cannot borrow authority from the
        // source app outside its selection, for either listing or linking.
        const connection = yield* okBody(
          Resource,
          yield* api.request(actors.admin, "POST", `${prefix}/mcp-connections`, {
            id: randomUUID(),
            name: "App reuse scope",
            apps: [
              {
                app: second.slice(second.lastIndexOf("/") + 1),
                runsAs: [{ kind: "app" }],
                tools: { kind: "all" },
              },
            ],
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.admin, "POST", `${prefix}/mcp-connections/${connection.id}/revoke`)
            .pipe(Effect.asVoid, Effect.orDie),
        );
        // A host-attached calling connection narrows the session's policy exactly as it does
        // for an agent's nested API calls. Connection keys themselves are MCP-only on this fork.
        const scoped: Session = {
          cookies: actors.admin.cookies,
          send: (method, path, data, headers) =>
            actors.admin.send(method, path, data, {
              ...headers,
              "x-executor-caller-connection": connection.id,
            }),
        };
        expect(yield* choices(scoped, second)).toEqual([]);
        yield* refused(yield* appLink(scoped, second, shared), 403, "OrganizationForbidden");
        yield* refused(
          yield* api.request(scoped, "GET", `${fixture.path}/accounts/app/team`),
          403,
          "OrganizationForbidden",
        );

        // The admin does not own the account, but it already serves an app they can edit, so they
        // may choose it for the second app and link it there for everyone. Every caller then runs
        // with it, and the admin still cannot read the account itself.
        expect(yield* choices(actors.admin, second)).toEqual([[shared, false]]);
        yield* ok(yield* appLink(actors.admin, second, shared));
        expect(yield* who(actors.member, second)).toEqual({ team: shared });
        expect(
          (yield* api.request(actors.admin, "GET", `${prefix}/accounts/${shared}`)).status,
        ).not.toBe(200);

        // Nothing else is opened: the admin cannot link the account for themselves, and an account
        // of the owner's that serves no app for everyone is neither offered nor linkable.
        const userTeam = yield* fixture.another(teamUserSource);
        yield* refused(
          yield* linkAccountResponse(actors.admin, userTeam, "team", shared),
          403,
          "OrganizationForbidden",
        );
        const ownerStarted = yield* start(actors.owner, "user", "team", userTeam);
        expect(ownerStarted.status, JSON.stringify(ownerStarted.body)).toBe(200);
        const personal = (yield* okBody(
          Resource,
          yield* submit(actors.owner, (yield* body(Resource, ownerStarted)).id, "team-personal"),
        )).id;
        yield* fixture.saved(actors.owner, personal);
        expect((yield* choices(actors.admin, second)).map(([id]) => id)).not.toContain(personal);
        yield* refused(
          yield* appLink(actors.admin, second, personal),
          403,
          "OrganizationForbidden",
        );

        // A member who cannot edit the second app cannot link to it either.
        yield* refused(yield* appLink(actors.member, second, shared), 403, "OrganizationForbidden");

        // A member links their own account for everyone to an app they created. The admin reuses
        // it for the second app, replacing its plain link. The account cannot be deleted while any
        // app links it, but the member, who cannot edit the second app, may still stop it using
        // their account, though not unlink another's.
        const created = yield* api.request(actors.member, "POST", `${prefix}/apps/deploy`, {
          name: `Member app ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: teamAppSource }, appsManifest],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const own = `${prefix}/apps/${(yield* body(Resource, created)).id}`;
        yield* fixture.adopt(own);
        const memberStarted = yield* start(actors.member, "app", "team", own);
        expect(memberStarted.status, JSON.stringify(memberStarted.body)).toBe(200);
        const memberTeam = (yield* okBody(
          Resource,
          yield* submit(actors.member, (yield* body(Resource, memberStarted)).id, "member-team"),
        )).id;
        yield* fixture.saved(actors.member, memberTeam);
        yield* ok(yield* appLink(actors.admin, second, memberTeam));
        yield* ok(
          yield* linkAccountResponse(actors.admin, second, "privateTeam", memberTeam, "app"),
        );
        expect(yield* who(actors.owner, second)).toEqual({ team: memberTeam });
        // Consent must work even when the account owner cannot read the app or discover its
        // requirement names. Only their own links' app ids leave the server.
        const access = yield* okBody(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${second}/access`),
        );
        yield* ok(
          yield* api.request(actors.owner, "PATCH", `${second}/access`, {
            revision: access.revision,
            audience: { kind: "private" },
          }),
        );
        for (const route of [second, `${second}/accounts/app`, `${second}/accounts/app/team`]) {
          const denied = yield* api.request(actors.member, "GET", route);
          yield* refused(denied, 403, "OrganizationForbidden");
          expect(JSON.stringify(denied.body)).not.toContain("privateTeam");
        }
        const deletion = yield* api.request(
          actors.member,
          "DELETE",
          `${prefix}/accounts/${memberTeam}`,
        );
        yield* refused(deletion, 409, "AccountLinkedToApp");
        expect(JSON.stringify(deletion.body)).not.toContain("privateTeam");
        expect(yield* body(Schema.Struct({ apps: Schema.Array(Schema.String) }), deletion)).toEqual(
          {
            apps: [own, second].map((path) => path.slice(path.lastIndexOf("/") + 1)).sort(),
          },
        );
        yield* refused(
          yield* appUnlink(actors.member, second, shared),
          403,
          "OrganizationForbidden",
        );
        const unlinkOwned = (path: string, account: string) =>
          api.request(actors.member, "DELETE", `${path}/accounts/app/${account}`);
        yield* refused(yield* unlinkOwned(second, shared), 403, "OrganizationForbidden");
        // An unrelated existing app and a nonexistent one give the same refusal.
        for (const path of [fixture.path, `${prefix}/apps/app_${randomUUID()}`])
          yield* refused(yield* unlinkOwned(path, memberTeam), 403, "OrganizationForbidden");
        expect(yield* ok(yield* unlinkOwned(second, memberTeam))).toEqual({
          app: second.slice(second.lastIndexOf("/") + 1),
          account: memberTeam,
        });
        expect(
          yield* ok(yield* api.request(actors.owner, "GET", `${second}/accounts/app`)),
        ).toEqual([]);
        yield* refused(yield* unlinkOwned(second, memberTeam), 403, "OrganizationForbidden");
        yield* refused(
          yield* api.request(actors.owner, "POST", `${second}/tools/call`, {
            tool: "who",
            kind: "query",
            input: {},
          }),
          409,
          "AccountRequired",
        );

        // Once the account serves no app the admin can edit, they cannot link it again.
        yield* ok(yield* appUnlink(actors.member, own, memberTeam));
        yield* refused(
          yield* appLink(actors.admin, second, memberTeam),
          403,
          "OrganizationForbidden",
        );
      }),
    ),
  );
  it.effect(scenarios.hostedAppLinkReuseChain.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([{ path: "index.ts", content: source }]);
        const { api, actors, prefix, connect } = fixture;
        const appLink = (actor: Session, appPath: string, account: string) =>
          linkAccountResponse(actor, appPath, "team", account, "app");
        const appUnlink = (actor: Session, appPath: string, account: string) =>
          api.request(
            actor,
            "DELETE",
            `${appPath}/accounts/app/team/${encodeURIComponent(account)}`,
          );
        const memberApp = Effect.gen(function* () {
          const created = yield* api.request(actors.member, "POST", `${prefix}/apps/deploy`, {
            name: `Member app ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: teamAppSource }, appsManifest],
          });
          expect(created.status, JSON.stringify(created.body)).toBe(200);
          const appPath = `${prefix}/apps/${(yield* body(Resource, created)).id}`;
          yield* fixture.adopt(appPath);
          return appPath;
        });

        // The owner links their own account for everyone to the fixture's app. A member cannot
        // link it to an app they created.
        const secret = yield* connect(actors.owner, "app", "team", "OWNER-SECRET-TOKEN");
        const m1 = yield* memberApp;
        yield* refused(yield* appLink(actors.member, m1, secret), 403, "OrganizationForbidden");

        // Nor can an administrator put it there for them: the member edits that app, so its code
        // could read the owner's credential. The account is not offered there either.
        yield* refused(yield* appLink(actors.admin, m1, secret), 403, "OrganizationForbidden");
        const offered = yield* api.request(actors.admin, "GET", `${m1}/accounts/app/team`);
        expect(
          (yield* okBody(LinkRequirement, offered)).accounts.map((entry) => entry.account.id),
        ).not.toContain(secret);

        // So the member has nothing to chain from: linking it to a second app of theirs is
        // refused, and that app's code never receives the owner's token.
        const m2 = yield* memberApp;
        yield* refused(yield* appLink(actors.member, m2, secret), 403, "OrganizationForbidden");
        const read = yield* api.request(actors.member, "POST", `${m2}/tools/call`, {
          tool: "who",
          kind: "query",
          input: {},
        });
        yield* refused(read, 409, "AccountRequired");
        expect(JSON.stringify(read.body)).not.toContain("OWNER-SECRET-TOKEN");

        // The administrator's unlink finds nothing in the member's app, and afterwards the member
        // still cannot link the account to any app of theirs.
        yield* refused(yield* appUnlink(actors.admin, m1, secret), 404, "AccountNotFound");
        const m4 = yield* memberApp;
        yield* refused(yield* appLink(actors.member, m4, secret), 403, "OrganizationForbidden");
        expect(yield* linkedAccountIds(actors.member, m4, "app")).toEqual([]);
      }),
    ),
  );
  it.effect(scenarios.hostedAppLinkReuseDeparted.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([{ path: "index.ts", content: source }]);
        const { api, actors, prefix, connect } = fixture;
        const appLink = (actor: Session, appPath: string, account: string) =>
          linkAccountResponse(actor, appPath, "team", account, "app");
        /** An app with one plain team requirement that `actor` creates. */
        const deployAs = (actor: Session) =>
          Effect.gen(function* () {
            const created = yield* api.request(actor, "POST", `${prefix}/apps/deploy`, {
              name: `Reuse departure ${randomUUID().slice(0, 8)}`,
              files: [{ path: "index.ts", content: teamAppSource }, appsManifest],
            });
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            const appPath = `${prefix}/apps/${(yield* body(Resource, created)).id}`;
            yield* fixture.adopt(appPath);
            return appPath;
          });
        const who = (actor: Session, appPath: string) =>
          api.request(actor, "POST", `${appPath}/tools/call`, {
            tool: "who",
            kind: "query",
            input: {},
          });
        const leaves = (actor: Session) =>
          Effect.gen(function* () {
            const { user } = yield* body(
              SessionIdentity,
              yield* api.request(actor, "GET", "/api/auth/get-session"),
            );
            yield* ok(
              yield* api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
                organizationId: actors.organization.id,
                memberIdOrEmail: user.email,
              }),
            );
          });

        // The member links their own account for everyone to an app they created, and the
        // administrator reuses it in an app of their own, whose code then runs with it.
        const memberSource = yield* deployAs(actors.member);
        const started = yield* api.request(
          actors.member,
          "POST",
          `${requirementPath(memberSource, "app", "team")}/connections`,
          {},
        );
        const saved = yield* okBody(
          Resource,
          yield* fixture.submit(
            actors.member,
            (yield* okBody(Resource, started)).id,
            "MEMBER-SECRET-TOKEN",
          ),
        );
        const memberAccount = saved.id;
        yield* fixture.saved(actors.member, memberAccount);
        const adminApp = yield* deployAs(actors.admin);
        yield* ok(yield* appLink(actors.admin, adminApp, memberAccount));
        expect(yield* okBody(TeamWho, yield* who(actors.admin, adminApp))).toEqual({
          team: memberAccount,
          token: "MEMBER-SECRET-TOKEN",
        });

        // The owner links theirs for everyone to the fixture's app, while the member still
        // created an app the administrator can edit.
        const secret = yield* connect(actors.owner, "app", "team", "OWNER-SECRET-TOKEN");
        const memberTarget = yield* deployAs(actors.member);
        yield* refused(
          yield* appLink(actors.admin, memberTarget, secret),
          403,
          "OrganizationForbidden",
        );

        // The member leaves. Their account stops serving every app, the administrator's included,
        // and the administrator can no longer reuse it anywhere.
        yield* leaves(actors.member);
        yield* refused(yield* who(actors.admin, adminApp), 409, "AccountRequired");
        const otherAdminApp = yield* deployAs(actors.admin);
        yield* refused(
          yield* appLink(actors.admin, otherAdminApp, memberAccount),
          403,
          "OrganizationForbidden",
        );

        // An app whose creator left still counts as theirs: invited back, they would edit it
        // again, so the owner's account is neither offered there nor linked.
        const offered = yield* api.request(
          actors.admin,
          "GET",
          `${memberTarget}/accounts/app/team`,
        );
        expect(
          (yield* okBody(LinkRequirement, offered)).accounts.map((entry) => entry.account.id),
        ).not.toContain(secret);
        yield* refused(
          yield* appLink(actors.admin, memberTarget, secret),
          403,
          "OrganizationForbidden",
        );
        expect(yield* linkedAccountIds(actors.admin, memberTarget, "app")).toEqual([]);
        // An app the administrator created still takes it.
        yield* ok(yield* appLink(actors.admin, otherAdminApp, secret));
        expect(yield* okBody(TeamWho, yield* who(actors.admin, otherAdminApp))).toEqual({
          team: secret,
          token: "OWNER-SECRET-TOKEN",
        });
      }),
    ),
  );
  it.effect(scenarios.hostedAppLinkCreatorDemotion.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([{ path: "index.ts", content: source }]);
        const { api, actors, prefix, connect } = fixture;
        const telemetry = yield* Telemetry;
        const creator = yield* okBody(
          SessionIdentity,
          yield* api.request(actors.admin, "GET", "/api/auth/get-session"),
        );
        const { members } = yield* okBody(
          Memberships,
          yield* api.request(
            actors.owner,
            "GET",
            `/api/auth/organization/list-members?organizationId=${actors.organization.id}`,
          ),
        );
        const membership = members.find((member) => member.user.email === creator.user.email);
        if (membership === undefined) return yield* Effect.die("The creator has no membership");
        const role = (role: "admin" | "member") =>
          Effect.gen(function* () {
            yield* ok(
              yield* api.request(
                actors.owner,
                "POST",
                "/api/auth/organization/update-member-role",
                {
                  organizationId: actors.organization.id,
                  memberId: membership.id,
                  role,
                },
              ),
            );
          });
        const token = `demotion-fixture-${randomUUID()}`;
        const account = yield* connect(actors.owner, "app", "team", token);
        const created = yield* okBody(
          Resource,
          yield* api.request(actors.admin, "POST", `${prefix}/apps/deploy`, {
            name: "Creator demotion",
            files: [{ path: "index.ts", content: teamAppSource }, appsManifest],
          }),
        );
        const path = `${prefix}/apps/${created.id}`;
        yield* fixture.adopt(path);
        const link = (actor: Session) => linkAccount(actor, path, "team", account, "app");
        const who = (traceparent?: string) =>
          api.request(
            actors.admin,
            "POST",
            `${path}/tools/call`,
            { tool: "who", kind: "query", input: {} },
            traceparent === undefined ? undefined : { traceparent },
          );
        const serves = Effect.gen(function* () {
          const served = yield* okBody(TeamWho, yield* who());
          expect(served.team).toBe(account);
          expect(served.token === token).toBe(true);
        });
        const action = "app_account.use_refused";
        yield* link(actors.admin);
        yield* serves;
        yield* role("member");

        // The creator can still use their app, but not the reused account.
        const first = traced();
        const declined = yield* who(first.traceparent);
        expect(declined.status).toBe(409);
        yield* refused(declined, 409, "AppLinkCreatorNotAuthorized");
        const logs = yield* telemetry.logs(first.traceId).pipe(
          Effect.filterOrFail(
            (logs) => logs.includes(action),
            () => new Error("The refusal audit has not reached the collector"),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
        );
        expect(auditOf(logs, action)).toEqual({
          "audit.action": action,
          "audit.outcome": "failure",
          "audit.target.kind": "account",
          "audit.target.id": account,
          "audit.app": created.id,
          "audit.requirement": "team",
          "audit.reason": "creator_not_admin_or_owner",
        });
        expect(logs.includes(token)).toBe(false);
        yield* refused(yield* who(first.traceparent), 409, "AppLinkCreatorNotAuthorized");

        yield* role("admin");
        yield* serves;
        yield* role("member");
        const second = traced();
        yield* refused(yield* who(second.traceparent), 409, "AppLinkCreatorNotAuthorized");
        const secondLogs = yield* telemetry.logs(second.traceId).pipe(
          Effect.filterOrFail(
            (logs) => logs.includes(action),
            () => new Error("The second demotion audit has not reached the collector"),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
        );
        expect(auditOf(secondLogs, action)["audit.target.id"]).toBe(account);
        expect(auditOf(yield* telemetry.logs(first.traceId), action)["audit.target.id"]).toBe(
          account,
        );

        // The account owner can make the link themselves without promoting the creator.
        yield* link(actors.owner);
        yield* serves;
        yield* role("admin");
        yield* role("member");
        yield* serves;
      }),
    ),
  );
  it.effect(scenarios.hostedAppLinkCreatorRemoval.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([{ path: "index.ts", content: source }]);
        const { api, actors, prefix, connect } = fixture;
        const telemetry = yield* Telemetry;
        const creator = yield* okBody(
          SessionIdentity,
          yield* api.request(actors.admin, "GET", "/api/auth/get-session"),
        );
        const { members } = yield* okBody(
          Memberships,
          yield* api.request(
            actors.owner,
            "GET",
            `/api/auth/organization/list-members?organizationId=${actors.organization.id}`,
          ),
        );
        const membership = members.find((member) => member.user.email === creator.user.email);
        if (membership === undefined) return yield* Effect.die("The creator has no membership");
        const token = `creator-removal-fixture-${randomUUID()}`;
        const account = yield* connect(actors.owner, "app", "team", token);
        const created = yield* okBody(
          Resource,
          yield* api.request(actors.admin, "POST", `${prefix}/apps/deploy`, {
            name: "Creator removal",
            files: [{ path: "index.ts", content: teamAppSource }, appsManifest],
          }),
        );
        const path = `${prefix}/apps/${created.id}`;
        yield* fixture.adopt(path);
        const who = (actor: Session) =>
          api.request(actor, "POST", `${path}/tools/call`, {
            tool: "who",
            kind: "query",
            input: {},
          });
        // The admin reuses the owner's account in the app they created, then is demoted.
        yield* linkAccount(actors.admin, path, "team", account, "app");
        expect((yield* okBody(TeamWho, yield* who(actors.owner))).token === token).toBe(true);
        yield* ok(
          yield* api.request(actors.owner, "POST", "/api/auth/organization/update-member-role", {
            organizationId: actors.organization.id,
            memberId: membership.id,
            role: "member",
          }),
        );
        yield* refused(yield* who(actors.owner), 409, "AppLinkCreatorNotAuthorized");

        // The owner removes them from the organization before they delete their user, so the
        // organization is no longer one of theirs when they do.
        yield* ok(
          yield* api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
            organizationId: actors.organization.id,
            memberIdOrEmail: creator.user.email,
          }),
        );
        yield* refused(yield* who(actors.owner), 409, "AppLinkCreatorNotAuthorized");

        // Deleting their user leaves the app without a creator; the reuse must not serve again.
        const removal = traced();
        const deleted = yield* api.request(actors.admin, "DELETE", "/api/user", undefined, {
          traceparent: removal.traceparent,
        });
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        const after = yield* who(actors.owner);
        expect(JSON.stringify(after.body).includes(token)).toBe(false);
        yield* refused(after, 409, "AccountRequired");
        expect(yield* linkedAccountIds(actors.owner, path, "app")).toEqual([]);
        const action = "app_account.unlink";
        const logs = yield* telemetry.logs(removal.traceId).pipe(
          Effect.filterOrFail(
            (logs) => logs.includes(action),
            () => new Error("The unlink audit has not reached the collector"),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
        );
        expect(auditOf(logs, action)).toEqual({
          "audit.action": action,
          "audit.outcome": "success",
          "audit.target.kind": "account",
          "audit.target.id": account,
          "audit.app": created.id,
          "audit.authority": "creator_removal",
        });
        expect(logs.includes(token)).toBe(false);

        // The account's owner can still link it to the app themselves.
        yield* linkAccount(actors.owner, path, "team", account, "app");
        expect((yield* okBody(TeamWho, yield* who(actors.owner))).token === token).toBe(true);
      }),
    ),
  );
  it.effect(scenarios.hostedAppLinkAudit.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([{ path: "index.ts", content: source }]);
        const { api, actors, prefix, path, app } = fixture;
        const telemetry = yield* Telemetry;
        /** The trace's audit record for `action`, once it reached the collector. */
        const audit = (traceId: string, action: string) =>
          telemetry.logs(traceId).pipe(
            Effect.filterOrFail(
              (logs) => logs.includes(action),
              () => new Error(`The ${action} record has not reached the collector`),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
            Effect.map((logs) => ({ logs, record: auditOf(logs, action) })),
          );
        const idOf = (appPath: string) => appPath.slice(appPath.lastIndexOf("/") + 1);

        // Connecting from the app links the owner's new account for everyone: recorded once the
        // save commits, as the owner's.
        const connected = traced();
        const started = yield* api.request(
          actors.owner,
          "POST",
          `${requirementPath(path, "app", "team")}/connections`,
          {},
        );
        const saved = yield* okBody(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${(yield* okBody(Resource, started)).id}/submit`,
            { method: "key", label: "AUDIT-OWNER-TOKEN", fields: { token: "AUDIT-OWNER-TOKEN" } },
            { traceparent: connected.traceparent },
          ),
        );
        const secret = saved.id;
        yield* fixture.saved(actors.owner, secret);
        const connect = yield* audit(connected.traceId, "app_account.link");
        expect(connect.record).toMatchObject({
          "audit.outcome": "success",
          "audit.target.kind": "account",
          "audit.target.id": secret,
          "audit.app": app.id,
          "audit.authority": "owner",
          "audit.via": "connect",
          "audit.changed": "true",
        });
        expect(connect.logs).not.toContain("AUDIT-OWNER-TOKEN");

        // The administrator reuses it in another app: recorded as a reuse.
        const other = yield* fixture.another(teamAppSource);
        const reused = traced();
        yield* ok(
          yield* api.request(
            actors.admin,
            "PUT",
            `${requirementPath(other, "app", "team")}/${secret}`,
            undefined,
            { traceparent: reused.traceparent },
          ),
        );
        expect((yield* audit(reused.traceId, "app_account.link")).record).toMatchObject({
          "audit.outcome": "success",
          "audit.target.id": secret,
          "audit.app": idOf(other),
          "audit.authority": "app_link",
          "audit.changed": "true",
        });

        // A refused link names no app, and never the one the request named.
        const missing = `app_${randomUUID()}`;
        const refusal = traced();
        const denied = yield* api.request(
          actors.admin,
          "PUT",
          `${requirementPath(`${prefix}/apps/${missing}`, "app", "team")}/${secret}`,
          undefined,
          { traceparent: refusal.traceparent },
        );
        expect(denied.status, JSON.stringify(denied.body)).not.toBe(200);
        const failed = yield* audit(refusal.traceId, "app_account.link");
        expect(failed.record).toMatchObject({ "audit.outcome": "failure" });
        expect(failed.record).not.toHaveProperty("audit.app");
        expect(failed.record).not.toHaveProperty("audit.target.id");
        expect(failed.logs).not.toContain(missing);

        // An editor's unlink of someone else's account is recorded as the app manager's.
        const managed = traced();
        yield* ok(
          yield* api.request(
            actors.admin,
            "DELETE",
            `${requirementPath(path, "app", "team")}/${secret}`,
            undefined,
            { traceparent: managed.traceparent },
          ),
        );
        expect((yield* audit(managed.traceId, "app_account.unlink")).record).toMatchObject({
          "audit.outcome": "success",
          "audit.target.id": secret,
          "audit.app": app.id,
          "audit.authority": "app_manager",
        });

        // Its owner's unlink from every requirement of the other app is recorded as the owner's.
        const owned = traced();
        yield* ok(
          yield* api.request(actors.owner, "DELETE", `${other}/accounts/app/${secret}`, undefined, {
            traceparent: owned.traceparent,
          }),
        );
        expect((yield* audit(owned.traceId, "app_account.unlink")).record).toMatchObject({
          "audit.outcome": "success",
          "audit.target.id": secret,
          "audit.app": idOf(other),
          "audit.authority": "owner",
        });
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
