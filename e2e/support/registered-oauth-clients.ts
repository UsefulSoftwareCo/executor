/**
 * Stored OAuth clients belong to the organization and the authorization server they sign in at,
 * so every app of that server reuses a client Executor registered for it. Scenarios that need a
 * fresh registration for another app of the same loopback server remove those clients first,
 * through the administrator API, as an administrator would.
 */
import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Api, body, type Session } from "./api.ts";

const ClientDirectory = Schema.Struct({
  clients: Schema.Array(
    Schema.Struct({
      client: Schema.Struct({
        id: Schema.String,
        issuer: Schema.NullOr(Schema.String),
        source: Schema.String,
      }),
    }),
  ),
});

/** Remove every client Executor registered automatically for the server at `issuer`. */
export const removeRegisteredClients = (session: Session, organization: string, issuer: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const prefix = `/api/organizations/${organization}`;
    const listed = yield* body(
      ClientDirectory,
      yield* api.request(session, "GET", `${prefix}/oauth-clients`),
    );
    for (const { client } of listed.clients)
      if (client.issuer === issuer && client.source === "registered") {
        const removed = yield* api.request(
          session,
          "DELETE",
          `${prefix}/oauth-clients/${client.id}`,
        );
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      }
  });
