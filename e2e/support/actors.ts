/** Hosted actor layers use normal HTTP setup or stage-owned synthetic session files. */
import { Clock, Effect, Context, FileSystem, Layer, Redacted, Schema } from "effect";
import { SessionClients, body, BrowserCookies, type Session } from "./api.ts";
import { Target } from "./platform.ts";
import { Organization, Resource } from "./contracts.ts";

/** Synthetic password is confined to the isolated self-host setup. */
export const password = "Synthetic-e2e-password-2026";
/** Host-independent authority used by the same scenario on both products. */
export class Actors extends Context.Service<
  Actors,
  {
    readonly owner: Session;
    readonly admin: Session;
    readonly member: Session;
    readonly organization: typeof Organization.Type;
  }
>()("e2e/Actors") {
  static readonly layer = Layer.effect(
    Actors,
    Effect.gen(function* () {
      const target = yield* Target;
      return yield* target.metadata.target === "cloud" && target.metadata.mode === "attached"
        ? cloudActors
        : storedSelfHostActors;
    }),
  );
}
const DevelopmentMembers = Schema.Struct({
  organization: Schema.Struct({ id: Schema.String }),
  accounts: Schema.Array(
    Schema.Struct({ id: Schema.String, email: Schema.String, role: Schema.String }),
  ),
});
const signInDevelopmentFixture = (session: Session, role: "owner" | "admin" | "member") =>
  Effect.gen(function* () {
    const api = yield* SessionClients;
    const directory = yield* body(
      DevelopmentMembers,
      yield* api.request(session, "GET", "/api/devtools"),
    );
    const emails = {
      owner: "agent-agent@example.test",
      admin: "agent-admin@example.test",
      member: "agent-rhys-member@example.test",
    };
    const member = directory.accounts.find(
      (account) => account.email === emails[role] && account.role === role,
    );
    if (!member)
      return yield* new ActorsUnavailable({ message: "Expected development fixture member" });
    return yield* api.request(session, "POST", "/api/devtools/account", {
      organization: directory.organization.id,
      userId: member.id,
    });
  });
/** Lifecycle tests own this fresh session, so sign-out cannot revoke shared actor fixtures. */
export const freshOwnerSession = Effect.gen(function* () {
  const target = yield* Target;
  const clients = yield* SessionClients;
  const session = yield* clients.session();
  if (target.metadata.target === "cloud" && target.metadata.mode === "attached")
    return yield* new ActorsUnavailable({
      message:
        "Session lifecycle checks require managed Cloud sign-in or self-host password sign-in",
    });
  const response = yield* target.metadata.target === "cloud"
    ? signInDevelopmentFixture(session, "owner")
    : clients.request(session, "POST", "/api/auth/sign-in/email", {
        email: "owner@example.test",
        password,
      });
  yield* ready(response.status);
  return session;
});
/** Provision the isolated self-host instance exactly once, before starting Vitest. */
export const provisionSelfHostActors = Effect.gen(function* () {
  const api = yield* SessionClients;
  const owner = yield* api.session();
  const configuration = yield* api.request(owner, "GET", "/api/auth/self-host/config");
  yield* ready(configuration.status);
  const { setup: fresh } = yield* body(Schema.Struct({ setup: Schema.Boolean }), configuration);
  const setup = yield* api.request(
    owner,
    "POST",
    fresh ? "/api/auth/self-host/setup" : "/api/auth/sign-in/email",
    {
      name: "Test Owner",
      email: "owner@example.test",
      password,
      organizationName: "Evidence lab",
    },
  );
  yield* ready(setup.status);
  const listed = yield* api.request(owner, "GET", "/api/auth/organization/list");
  yield* ready(listed.status);
  const organizations = yield* body(Schema.Array(Organization), listed);
  if (organizations.length !== 1)
    return yield* new ActorsUnavailable({ message: "Expected one self-host organization" });
  const organization = organizations[0];
  if (!organization) return yield* Effect.die(new Error("Setup did not create an organization"));
  const join = (role: "admin" | "member") =>
    Effect.gen(function* () {
      const session = yield* api.session();
      if (!fresh) {
        const login = yield* api.request(session, "POST", "/api/auth/sign-in/email", {
          email: `${role}@example.test`,
          password,
        });
        if (login.status === 200) return session;
      }
      const invitation = yield* api.request(owner, "POST", "/api/auth/organization/invite-member", {
        email: `${role}@example.test`,
        role,
        organizationId: organization.id,
        resend: true,
      });
      yield* ready(invitation.status);
      const { id } = yield* body(Resource, invitation);
      const joined = yield* api.request(session, "POST", "/api/auth/self-host/register", {
        invitation: id,
        email: `${role}@example.test`,
        name: `Test ${role}`,
        password,
      });
      yield* ready(joined.status);
      return session;
    });
  return { owner, admin: yield* join("admin"), member: yield* join("member"), organization };
});
/** Use the running Cloud dev server's normal account-switching surface for role fixtures.
 * Onboarding tests do not use these sessions and still complete every sign-in step.
 */
export const provisionCloudActors = Effect.gen(function* () {
  const api = yield* SessionClients;
  const signIn = (role: "owner" | "admin" | "member") =>
    Effect.gen(function* () {
      const session = yield* api.session();
      yield* ready((yield* signInDevelopmentFixture(session, role)).status);
      return session;
    });
  const owner = yield* signIn("owner");
  const listed = yield* api.request(owner, "GET", "/api/auth/organization/list");
  yield* ready(listed.status);
  const organizations = yield* body(Schema.Array(Organization), listed);
  const organization = organizations[0];
  if (organizations.length !== 1 || !organization)
    return yield* new ActorsUnavailable({
      message: "Expected one development fixture organization",
    });
  return { owner, admin: yield* signIn("admin"), member: yield* signIn("member"), organization };
});

const Actor = Schema.Struct({
  userId: Schema.String,
  role: Schema.Literals(["owner", "admin", "member"]),
  expiresAt: Schema.String,
  cookies: BrowserCookies,
});
const Sessions = Schema.Struct({
  version: Schema.Literal(1),
  stage: Schema.String,
  origin: Schema.String,
  organization: Organization,
  actors: Schema.Struct({ owner: Actor, admin: Actor, member: Actor }),
});
class ActorsUnavailable extends Schema.TaggedError<ActorsUnavailable>()("ActorsUnavailable", {
  message: Schema.String,
}) {}
const cloudActors = Effect.gen(function* () {
  const target = yield* Target,
    api = yield* SessionClients,
    fs = yield* FileSystem.FileSystem;
  if (!target.cloudActors)
    return yield* new ActorsUnavailable({
      message: "Set E2E_CLOUD_ACTORS to a private session file from the dedicated stage.",
    });
  const info = yield* fs.stat(target.cloudActors);
  if ((info.mode & 0o077) !== 0)
    return yield* new ActorsUnavailable({ message: "Session file must be private (0600)." });
  const sessions = yield* fs.readFileString(target.cloudActors).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Sessions))),
    Effect.map(Redacted.make),
    Effect.mapError(
      () =>
        new ActorsUnavailable({ message: "Invalid private session file. Provision fresh actors." }),
    ),
  );
  const config = Redacted.value(sessions),
    origin = target.metadata.origin;
  if (
    !config.stage.startsWith("test-e2e-") ||
    config.origin !== origin ||
    origin !== `https://${config.stage.slice(5)}.executor.engineering`
  )
    return yield* new ActorsUnavailable({
      message: "Session file must match the exact dedicated stage.",
    });
  const client = (role: "owner" | "admin" | "member") =>
    Effect.gen(function* () {
      const actor = config.actors[role];
      const now = yield* Clock.currentTimeMillis;
      if (
        actor.role !== role ||
        !(Date.parse(actor.expiresAt) > now + 60000) ||
        !actor.cookies.length ||
        actor.cookies.some((cookie) => cookie.domain !== new URL(origin).hostname || !cookie.secure)
      )
        return yield* new ActorsUnavailable({ message: "Fixture session expired or mismatched." });
      const session = yield* api.session(Redacted.make(actor.cookies));
      const identity = yield* api.request(session, "GET", "/api/viewer");
      yield* ready(identity.status);
      if ((yield* body(Schema.Struct({ userId: Schema.String }), identity)).userId !== actor.userId)
        return yield* new ActorsUnavailable({ message: "Cloud fixture identity changed" });
      const access = yield* api.request(
        session,
        "GET",
        `/api/organizations/${config.organization.id}/access`,
      );
      yield* ready(access.status);
      const current = yield* body(
        Schema.Struct({ role: Schema.String, organization: Schema.String }),
        access,
      );
      if (current.role !== role || current.organization !== config.organization.id)
        return yield* new ActorsUnavailable({ message: "Cloud fixture authority changed" });
      return session;
    });
  return {
    owner: yield* client("owner"),
    admin: yield* client("admin"),
    member: yield* client("member"),
    organization: config.organization,
  };
});

const ready = (status: number) =>
  status === 200
    ? Effect.void
    : Effect.fail(new ActorsUnavailable({ message: `Actor setup responded ${status}` }));
const StoredSelfHost = Schema.Struct({
  origin: Schema.String,
  organization: Organization,
  owner: BrowserCookies,
  admin: BrowserCookies,
  member: BrowserCookies,
});
const storedSelfHostActors = Effect.gen(function* () {
  const target = yield* Target,
    fs = yield* FileSystem.FileSystem,
    clients = yield* SessionClients;
  const value = yield* fs.readFileString(`${target.directory}/actors.json`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(StoredSelfHost))),
    Effect.map(Redacted.make),
    Effect.mapError(
      () => new ActorsUnavailable({ message: "Self-host fixture state missing or invalid" }),
    ),
  );
  const stored = Redacted.value(value);
  if (stored.origin !== target.metadata.origin)
    return yield* new ActorsUnavailable({ message: "Self-host fixtures belong to another target" });
  return {
    organization: stored.organization,
    owner: yield* clients.session(Redacted.make(stored.owner)),
    admin: yield* clients.session(Redacted.make(stored.admin)),
    member: yield* clients.session(Redacted.make(stored.member)),
  };
});
