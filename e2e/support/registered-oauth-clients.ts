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
