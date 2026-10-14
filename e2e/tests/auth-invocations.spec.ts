/**
 * Cloud keeps one Better Auth instance for each Worker isolate. Concurrent requests from
 * different users must still read their own sessions.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";

const SessionBody = Schema.Struct({
  user: Schema.Struct({ id: Schema.String }),
  session: Schema.Struct({ userId: Schema.String }),
});

/** Read the caller's session. */
const readSession = (actor: Session) =>
  Effect.gen(function* () {
    const response = yield* actor.send("GET", "/api/auth/get-session");
    expect(response.status).toBe(200);
    return yield* body(SessionBody, response);
  });

layer(HostedLive, { excludeTestServices: true })("Auth invocations", (it) => {
  it.effect(scenarios.authInvocations.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const people = [actors.owner, actors.admin, actors.member];
        const users = yield* Effect.forEach(people, (actor) =>
          readSession(actor).pipe(Effect.map((session) => session.user.id)),
        );
        expect(new Set(users).size).toBe(people.length);

        // Interleave every user's requests so they share the Worker at the same time.
        const reads = yield* Effect.forEach(
          Array.from({ length: 4 }, () => people.map((actor, index) => ({ actor, index }))).flat(),
          ({ actor, index }) =>
            readSession(actor).pipe(Effect.map((session) => ({ session, user: users[index] }))),
          { concurrency: "unbounded" },
        );
        for (const read of reads) {
          expect(read.session.user.id).toBe(read.user);
          expect(read.session.session.userId).toBe(read.user);
        }
      }),
    ),
  );
});
