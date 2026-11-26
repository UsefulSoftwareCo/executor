import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Layer, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, SessionClients, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { connectionsPath, requirementPath } from "../support/app-accounts.ts";
import { startDevelopmentServer } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp, defineProvider, secrets, object, string, router } from "apps";
const service = defineProvider({ name: "Held link fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ app: { accounts: { service } } }, async () => ({ tools: router({}) }));`;
const userSource = source.replace("{ app: { accounts", "{ user: { accounts");

const statementHold = "/api/devtools/statement-hold";
const Held = Schema.Struct({ held: Schema.Boolean });
const Users = Schema.Struct({
  users: Schema.Array(Schema.Struct({ id: Schema.String, email: Schema.String })),
});
const Organizations = Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String }));
const Members = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({ id: Schema.String, user: Schema.Struct({ email: Schema.String }) }),
  ),
});
const Revision = Schema.Struct({ revision: Schema.String });
const Links = Schema.Array(
  Schema.Struct({ requirement: Schema.String, account: Schema.Struct({ id: Schema.String }) }),
);
const Failure = Schema.Struct({ _tag: Schema.String });
const AccessInvalid = Schema.Struct({ _tag: Schema.String, reason: Schema.String });

const heldCase = (scope: "app" | "user") =>
  Effect.gen(function* () {
    const target = yield* Target;
    const origin = yield* startDevelopmentServer(target);
    const api = yield* Api.pipe(
      Effect.provide(Layer.fresh(Api.layer)),
      Effect.provide(Layer.fresh(SessionClients.layer)),
      Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
    );
    const headers = { origin };
    const send = (
      actor: Session,
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      path: string,
      payload?: unknown,
    ) => api.request(actor, method, `${origin}${path}`, payload, headers);
    const owner = yield* api.session();
    expect((yield* send(owner, "POST", "/api/devtools/operator", {})).status).toBe(200);
    const directory = yield* body(Users, yield* send(owner, "GET", "/api/auth/admin/list-users"));
    const developer = directory.users.find((user) => user.email === "agent-agent@example.test");
    if (!developer) return yield* Effect.die("Development owner is missing");
    expect(
      (yield* send(owner, "POST", "/api/auth/admin/impersonate-user", { userId: developer.id }))
        .status,
    ).toBe(200);
    const organization = (yield* body(
      Organizations,
      yield* send(owner, "GET", "/api/auth/organization/list"),
    ))[0];
    if (!organization) return yield* Effect.die("Development organization is missing");
    const prefix = `/api/organizations/${organization.id}`;
    yield* Effect.addFinalizer(() => send(owner, "DELETE", statementHold).pipe(Effect.orDie));

    const email = `held-admin-${randomUUID().slice(0, 8)}@example.test`;
    const invitation = yield* body(
      Resource,
      yield* send(owner, "POST", "/api/auth/organization/invite-member", {
        organizationId: organization.id,
        email,
        role: "admin",
      }),
    );
    const admin = yield* api.session();
    expect(
      (yield* send(admin, "POST", "/api/auth/self-host/register", {
        invitation: invitation.id,
        name: "Held Admin",
        email,
        password: "password1234",
      })).status,
    ).toBe(200);
    const members = yield* body(
      Members,
      yield* send(
        owner,
        "GET",
        `/api/auth/organization/list-members?organizationId=${organization.id}`,
      ),
    );
    const membership = members.members.find((item) => item.user.email === email);
    if (!membership) return yield* Effect.die("The admin's membership is missing");
    const setRole = (role: "admin" | "member") =>
      send(owner, "POST", "/api/auth/organization/update-member-role", {
        organizationId: organization.id,
        memberId: membership.id,
        role,
      }).pipe(Effect.map((response) => expect(response.status).toBe(200)));

    const deployed = yield* send(owner, "POST", `${prefix}/apps/deploy`, {
      name: `Held links ${randomUUID().slice(0, 8)}`,
      files: [{ path: "index.ts", content: scope === "app" ? source : userSource }, appsManifest],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = (yield* body(App, deployed)).id;
    const appPath = `${prefix}/apps/${app}`;
    const accounts: { actor: Session; id: string }[] = [];
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* send(owner, "DELETE", appPath);
        for (const account of accounts)
          yield* send(account.actor, "DELETE", `${prefix}/accounts/${account.id}`);
      }).pipe(Effect.orDie),
    );
    const connect = (actor: Session, token: string) =>
      Effect.gen(function* () {
        const started = yield* send(actor, "POST", connectionsPath(appPath, scope, "service"), {});
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const saved = yield* send(
          actor,
          "POST",
          `${prefix}/connections/${(yield* body(Resource, started)).id}/submit`,
          { method: "key", label: token, fields: { token } },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const account = (yield* body(Resource, saved)).id;
        accounts.push({ actor, id: account });
        return account;
      });
    const links = (actor: Session) =>
      send(actor, "GET", `${appPath}/accounts/${scope}`).pipe(
        Effect.flatMap((response) => body(Links, response)),
        Effect.map((found) => found.map((link) => [link.requirement, link.account.id])),
      );

    const held = <E, R>(
      check: "app-access" | "account-access",
      id: string,
      request: ReturnType<typeof send>,
      meanwhile: Effect.Effect<unknown, E, R>,
    ) =>
      Effect.gen(function* () {
        expect((yield* send(owner, "POST", statementHold, { after: check, id })).status).toBe(200);
        const fiber = yield* Effect.forkChild(request);
        yield* send(owner, "GET", statementHold).pipe(
          Effect.flatMap((response) => body(Held, response)),
          Effect.flatMap((current) =>
            current.held
              ? Effect.void
              : Effect.fail(new Error(`The request's ${check} check was not held`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }),
        );
        yield* meanwhile;
        yield* send(owner, "DELETE", statementHold);
        return yield* Fiber.join(fiber);
      });
    return {
      send,
      owner,
      admin,
      prefix,
      app,
      appPath,
      setRole,
      connect,
      links,
      held,
    };
  });

const refused = (response: { readonly status: number; readonly body: unknown }) =>
  Effect.gen(function* () {
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect((yield* body(Failure, response))._tag).toBe("OrganizationForbidden");
  });

layer(HostedLive, { excludeTestServices: true })("App account link held access", (it) => {
  it.effect(scenarios.hostedAppLinkHeldAccess.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { send, admin, owner, app, setRole, connect, links, held, appPath } =
          yield* heldCase("app");
        const appLinks = links(owner);
        const linkPath = (account: string) =>
          `${requirementPath(appPath, "app", "service")}/${account}`;

        const first = yield* connect(admin, "synthetic-held-first");
        const second = yield* connect(owner, "synthetic-held-second");
        expect(yield* appLinks).toEqual([["service", second]]);

        const demoted = yield* held(
          "account-access",
          first,
          send(admin, "PUT", linkPath(first)),
          setRole("member"),
        );
        yield* refused(demoted);
        expect(yield* appLinks).toEqual([["service", second]]);
        yield* setRole("admin");

        const linked = yield* held(
          "account-access",
          first,
          send(admin, "PUT", linkPath(first)),
          Effect.void,
        );
        expect(linked.status, JSON.stringify(linked.body)).toBe(200);
        expect(yield* appLinks).toEqual([["service", first]]);

        const kept = yield* held(
          "app-access",
          app,
          send(admin, "DELETE", linkPath(first)),
          setRole("member"),
        );
        yield* refused(kept);
        expect(yield* appLinks).toEqual([["service", first]]);
        yield* setRole("admin");

        const unlinked = yield* held(
          "app-access",
          app,
          send(admin, "DELETE", linkPath(first)),
          Effect.void,
        );
        expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
        expect(yield* appLinks).toEqual([]);
      }),
    ),
  );

  it.effect(scenarios.hostedMcpLinkHeldAccess.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { send, admin, owner, prefix, app, appPath, connect, links, held } =
          yield* heldCase("user");
        const appAccess = (audience: unknown) =>
          Effect.gen(function* () {
            const path = `${appPath}/access`;
            const { revision } = yield* body(Revision, yield* send(owner, "GET", path));
            const shared = yield* send(owner, "PATCH", path, { revision, audience });
            expect(shared.status, JSON.stringify(shared.body)).toBe(200);
          });
        yield* appAccess({ kind: "everyone" });
        const account = yield* connect(admin, "synthetic-held-mcp");
        expect(yield* links(admin)).toEqual([["service", account]]);
        const unlinked = yield* send(
          admin,
          "DELETE",
          `${requirementPath(appPath, "user", "service")}/${account}`,
        );
        expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
        expect(yield* links(admin)).toEqual([]);
        const save = () =>
          send(admin, "POST", `${prefix}/mcp-connections`, {
            id: randomUUID(),
            name: `Held connection ${randomUUID().slice(0, 8)}`,
            apps: [{ app, runsAs: [{ kind: "account", id: account }], tools: { kind: "all" } }],
          });

        const unsharedApp = yield* held(
          "account-access",
          account,
          save(),
          appAccess({ kind: "private" }),
        );
        expect(unsharedApp.status, JSON.stringify(unsharedApp.body)).toBe(400);
        expect(yield* body(AccessInvalid, unsharedApp)).toMatchObject({
          _tag: "ConnectionAccessInvalid",
          reason: "app",
        });
        yield* appAccess({ kind: "everyone" });
        expect(yield* links(admin)).toEqual([]);

        const saved = yield* held("account-access", account, save(), Effect.void);
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(yield* links(admin)).toEqual([["service", account]]);
        const revoked = yield* send(
          admin,
          "POST",
          `${prefix}/mcp-connections/${(yield* body(Resource, saved)).id}/revoke`,
        );
        expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      }),
    ),
  );
});
