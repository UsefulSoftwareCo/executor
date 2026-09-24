/** Hosted actor layers own independent organizations and sessions for each scenario. */
import { Clock, Effect, Context, Layer, Redacted, Schedule, Schema } from "effect";
import { RequestFailed, SessionClients, body, type Session } from "./api.ts";
import { Target } from "./platform.ts";
import { Organization, Resource } from "./contracts.ts";
import { FixtureActors, FixtureActor, FixtureFailed, fixtureRequest } from "../sdk/fixtures.ts";

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
      return yield* target.metadata.target === "cloud"
        ? createCloudScenarioActors
        : provisionSelfHostActors;
    }),
  );
}
/** Lifecycle tests own this fresh session, so sign-out cannot revoke shared actor fixtures. */
export const freshOwnerSession = Effect.gen(function* () {
  const target = yield* Target;
  const clients = yield* SessionClients;
  const session = yield* clients.session();
  if (target.metadata.target === "cloud") {
    const actors = yield* Actors;
    if (target.fixtures === undefined || target.scenarioId === undefined)
      return yield* new FixtureFailed({
        operation: "Cloud scenario requires its fixture capability",
      });
    const value = yield* fixtureRequest(target.fixtures, "/session", {
      id: target.scenarioId,
      role: "owner",
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(FixtureActor)));
    const renewed = yield* clients.session(Redacted.make(value.cookies));
    yield* ready(
      (yield* clients.request(
        renewed,
        "GET",
        `/api/organizations/${actors.organization.id}/access`,
      )).status,
    );
    return renewed;
  }
  const response = yield* clients.request(session, "POST", "/api/auth/sign-in/email", {
    email: "owner@example.test",
    password,
  });
  yield* ready(response.status);
  return session;
});
/** Provision one isolated self-host instance through its real signup and invitation endpoints. */
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
/** Create an isolated Cloud organization and identities through the local fixture control process. */
export const createCloudScenarioActors = Effect.gen(function* () {
  const target = yield* Target,
    clients = yield* SessionClients;
  if (target.fixtures === undefined || target.scenarioId === undefined)
    return yield* new FixtureFailed({
      operation: "Cloud scenarios require a runner-owned fixture capability",
    });
  const control = target.fixtures,
    id = target.scenarioId;
  yield* Effect.addFinalizer(() => fixtureRequest(control, "/remove", { id }).pipe(Effect.orDie));
  const value = yield* fixtureRequest(target.fixtures, "/actors", {
    id: target.scenarioId,
    label: target.scenarioLabel ?? "Interactive scenario",
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(FixtureActors)));
  if (value.origin !== target.metadata.origin || value.id !== target.scenarioId)
    return yield* new FixtureFailed({ operation: "Fixture origin or identity differs" });
  const client = (role: "owner" | "admin" | "member") =>
    Effect.gen(function* () {
      const actor = value.actors[role];
      if (Date.parse(actor.expiresAt) <= (yield* Clock.currentTimeMillis) + 60000)
        return yield* new FixtureFailed({ operation: "Fixture session expired" });
      return yield* clients.session(Redacted.make(actor.cookies));
    });
  const actors = {
    organization: value.organization,
    owner: yield* client("owner"),
    admin: yield* client("admin"),
    member: yield* client("member"),
  };
  // Trigger the normal product provisioning path for the synthetic identities.
  yield* Effect.forEach(
    [actors.owner, actors.admin, actors.member],
    (actor) =>
      clients.request(actor, "POST", "/api/onboarding/prepare").pipe(
        // A temporary deployment Worker has not run the application handler.
        // Only fixture preparation waits for that explicit propagation state.
        Effect.retry({
          while: (error) => Schema.is(RequestFailed)(error) && error.reason === "deployment",
          schedule: Schedule.spaced("500 millis"),
          times: 20,
        }),
        Effect.flatMap((response) => ready(response.status)),
      ),
    { concurrency: 3 },
  );
  return actors;
});

const ready = (status: number) =>
  status === 200
    ? Effect.void
    : Effect.fail(new ActorsUnavailable({ message: `Actor setup responded ${status}` }));
class ActorsUnavailable extends Schema.TaggedError<ActorsUnavailable>()("ActorsUnavailable", {
  message: Schema.String,
}) {}
