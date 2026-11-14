/** An OAuth client ID that storage cannot hold is a bad request, not a storage failure. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

const Registered = Schema.Struct({
  client: Schema.Struct({ id: Schema.String, clientId: Schema.String }),
  access: Schema.Struct({ revision: Schema.String }),
});
const Directory = Schema.Struct({
  clients: Schema.Array(Schema.Struct({ client: Schema.Struct({ id: Schema.String }) })),
});

/** A NUL cannot be stored, so a client ID that carries one is refused before it is saved. */
const withNul = ["a\u0000b", "\u0000"];

layer(HostedLive, { excludeTestServices: true })("OAuth client input validation", (it) => {
  it.effect(scenarios.oauthClientInputValidation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}/oauth-clients`;
        const issuer = "https://oauth-client-validation.invalid/";
        const refused = (label: string, response: { status: number; body: unknown }) =>
          expect(response.status, `${label}: ${JSON.stringify(response.body)}`).toBe(400);
        const listed = Effect.gen(function* () {
          const directory = yield* api.request(actors.owner, "GET", prefix);
          expect(directory.status, JSON.stringify(directory.body)).toBe(200);
          return (yield* body(Directory, directory)).clients.map(({ client }) => client.id);
        });
        const before = yield* listed;

        for (const clientId of withNul)
          refused(
            `register ${JSON.stringify(clientId)}`,
            yield* api.request(actors.owner, "POST", prefix, { issuer, clientId }),
          );
        expect(yield* listed, "a refused registration saves nothing").toEqual(before);

        // A client ID without NUL registers, and keeps being editable.
        const clientId = `synthetic-validation-${randomUUID().slice(0, 8)}`;
        const registered = yield* api.request(actors.owner, "POST", prefix, {
          issuer,
          clientId,
          clientSecret: "synthetic-validation-secret",
        });
        expect(registered.status, JSON.stringify(registered.body)).toBe(200);
        const { client, access } = yield* body(Registered, registered);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${client.id}`).pipe(Effect.orDie),
        );

        for (const edited of withNul)
          refused(
            `edit ${JSON.stringify(edited)}`,
            yield* api.request(actors.owner, "PATCH", `${prefix}/${client.id}`, {
              clientId: edited,
              revision: access.revision,
            }),
          );
        const renamed = `${clientId}-edited`;
        const edit = yield* api.request(actors.owner, "PATCH", `${prefix}/${client.id}`, {
          clientId: renamed,
          revision: access.revision,
        });
        expect(
          edit.status,
          `a refused edit left the revision usable: ${JSON.stringify(edit.body)}`,
        ).toBe(200);
        expect((yield* body(Registered, edit)).client.clientId).toBe(renamed);
      }),
    ),
  );
});
