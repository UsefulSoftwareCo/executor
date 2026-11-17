/**
 * Real self-host invitation registration, replay, concurrency, existing-account authority and the
 * registration rate limit.
 *
 * Setup and registration take sign-in's limit: three requests from one address every ten seconds,
 * counted for each path. Every request here comes from one address, and provisioning has already
 * set up the instance and registered the admin and the member, so a scenario that needs the
 * registration window first spends what is left of it and waits out the time Better Auth names.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Api, body, type Session } from "../support/api.ts";
import { Actors, password } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const SessionIdentity = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });
const Invitations = Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String }));
const Access = Schema.Struct({ role: Schema.String });
/** Seconds named by Better Auth's X-Retry-After header, within the ten-second window. */
const retryAfter = Schema.decodeUnknownEffect(
  Schema.NumberFromString.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(10)),
);

/** A request from a client without cookies, with the limit's retry time when it refuses. */
const postAnonymously = (path: "setup" | "register", input: Record<string, string>) =>
  Effect.gen(function* () {
    const target = yield* Target,
      http = yield* HttpClient.HttpClient;
    const origin = target.metadata.origin;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const request = yield* HttpClientRequest.post(`${origin}/api/auth/self-host/${path}`).pipe(
          HttpClientRequest.setHeaders({ origin }),
          HttpClientRequest.bodyJson({ ...input, name: "Invited user" }),
        );
        const response = yield* http.execute(request);
        yield* response.text;
        return { status: response.status, retryAfter: response.headers["x-retry-after"] };
      }),
    );
  });

/**
 * Repeat `attempt` until it is refused for its rate, and return the seconds the refusal names.
 * Every answer before then is `refused`. Provisioning spent at most two of the path's three
 * requests, so the first attempt is always answered and the fourth at the latest is limited.
 */
const spendLimit = (attempt: ReturnType<typeof postAnonymously>, refused: number) =>
  Effect.gen(function* () {
    const statuses: Array<number> = [];
    let wait: number | undefined;
    while (wait === undefined && statuses.length < 4) {
      const answer = yield* attempt;
      statuses.push(answer.status);
      if (answer.status === 429) wait = yield* retryAfter(answer.retryAfter);
    }
    expect(statuses[0]).toBe(refused);
    expect(statuses.slice(0, -1).every((status) => status === refused)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    return wait ?? 0;
  });
/** Spend what is left of the registration window and wait until a new one opens. */
const spendRegistrationLimit = (input: Record<string, string>, refused: number) =>
  Effect.flatMap(spendLimit(postAnonymously("register", input), refused), (wait) =>
    Effect.sleep(`${wait} seconds`),
  );

layer(HostedLive, { excludeTestServices: true })("Invitation redemption", (it) => {
  const setup = Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const organizationId = actors.organization.id;
    const invite = (inviter: Session, email: string, role: "admin" | "member") =>
      Effect.gen(function* () {
        const response = yield* api.request(
          inviter,
          "POST",
          "/api/auth/organization/invite-member",
          { organizationId, email, role },
        );
        expect(response.status).toBe(200);
        return (yield* body(Resource, response)).id;
      });
    const register = (session: Session, invitation: string, email: string, secret = password) =>
      api.request(session, "POST", "/api/auth/self-host/register", {
        invitation,
        email,
        name: "Invited user",
        password: secret,
      });
    const role = (session: Session) =>
      Effect.flatMap(
        api.request(session, "GET", `/api/organizations/${organizationId}/access`),
        (response) => body(Access, response),
      ).pipe(Effect.map((access) => access.role));
    const invitations = Effect.flatMap(
      api.request(
        actors.owner,
        "GET",
        `/api/auth/organization/list-invitations?organizationId=${organizationId}`,
      ),
      (response) => body(Invitations, response),
    );
    const status = (id: string) =>
      Effect.map(invitations, (all) => all.find((invitation) => invitation.id === id)?.status);
    const emailOf = (session: Session) =>
      Effect.flatMap(api.request(session, "GET", "/api/auth/get-session"), (response) =>
        body(SessionIdentity, response),
      ).pipe(Effect.map((identity) => identity.user.email));
    const remove = (email: string) =>
      Effect.flatMap(
        api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
          organizationId,
          memberIdOrEmail: email,
        }),
        (response) => Effect.sync(() => expect(response.status).toBe(200)),
      );
    return { api, actors, invite, register, role, status, emailOf, remove };
  });

  it.effect(scenarios.invitationRedemption.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, invite, register, role } = yield* setup;
        const email = "new-admin@example.test";
        const invitation = yield* invite(actors.admin, email, "admin");
        // An unknown invitation is refused, and so is every attempt past the limit.
        yield* spendRegistrationLimit({ invitation: "unknown-invitation", email, password }, 403);
        // The window is fresh: these three registrations fit in it.
        const recipient = yield* api.session();
        expect((yield* register(recipient, invitation, "wrong@example.test")).status).toBe(403);
        const rival = yield* api.session();
        const raced = yield* Effect.all(
          [register(recipient, invitation, email), register(rival, invitation, email)],
          { concurrency: 2 },
        );
        expect(raced.map((response) => response.status).sort()).toEqual([200, 403]);
        const login = yield* api.session();
        expect(
          (yield* api.request(login, "POST", "/api/auth/sign-in/email", { email, password }))
            .status,
        ).toBe(200);
        expect(yield* role(login)).toBe("admin");
        // Cancelling the accepted invitation is refused and leaves the membership in place.
        expect(
          (yield* api.request(actors.admin, "POST", "/api/auth/organization/cancel-invitation", {
            invitationId: invitation,
          })).status,
        ).toBe(400);
        expect(yield* role(login)).toBe("admin");
        // Setup is refused once the instance has an owner, and repeated attempts are limited.
        yield* spendLimit(
          postAnonymously("setup", { email, password, organizationName: "Second organization" }),
          403,
        );
      }),
    ),
  );

  it.effect(scenarios.invitationReadmission.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, invite, register, role, status, emailOf, remove } = yield* setup;
        // The admin invites someone and leaves; the owner invites them back as a member.
        const email = yield* emailOf(actors.admin);
        const departedEmail = "invited-by-departed@example.test";
        const departed = yield* invite(actors.admin, departedEmail, "admin");
        yield* remove(email);
        const readmission = yield* invite(actors.owner, email, "member");
        expect(yield* status(departed)).toBe("canceled");
        expect(yield* status(readmission)).toBe("pending");
        // A wrong password for the existing account is refused, and guesses are limited.
        yield* spendRegistrationLimit(
          { invitation: readmission, email, password: "attacker-chosen-password" },
          403,
        );
        // Refused guesses roll back, so the invitation is still pending.
        expect(yield* status(readmission)).toBe("pending");
        // The window is fresh: these three registrations fit in it.
        expect((yield* register(yield* api.session(), departed, departedEmail)).status).toBe(403);
        const recipient = yield* api.session();
        expect((yield* register(recipient, readmission, email)).status).toBe(200);
        expect(yield* role(recipient)).toBe("member");
        expect((yield* register(yield* api.session(), readmission, email)).status).toBe(403);
        // The guesses never replaced the account's password.
        expect(
          (yield* api.request(yield* api.session(), "POST", "/api/auth/sign-in/email", {
            email,
            password: "attacker-chosen-password",
          })).status,
        ).toBe(401);
      }),
    ),
  );
});
