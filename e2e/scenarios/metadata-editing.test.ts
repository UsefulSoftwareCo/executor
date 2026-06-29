// Cross-target: the curate-your-catalog promise. An integration's display
// name and description, and a connection's description, are user-editable
// metadata — set them after the fact and they persist and read back. This is
// the write half of the descriptions feature; openapi-update-spec covers the
// half where a curated description SURVIVES a spec refresh.
import { randomBytes, randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

/** Minimal apiKey-authenticated spec — a connection can bind to it; the single
 *  operation is never invoked here. */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Ping API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: { operationId: "ping", summary: "Ping", responses: { "200": { description: "pong" } } },
    },
  },
});

scenario(
  "Metadata · an integration's name/description and a connection's description are editable",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const apiClient = yield* client(api, yield* target.newIdentity());

    const slug = IntegrationSlug.make(`meta-edit-${randomBytes(4).toString("hex")}`);
    const connectionName = ConnectionName.make(`conn${randomBytes(4).toString("hex")}`);

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* apiClient.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: pingSpec },
            slug,
            baseUrl: "http://127.0.0.1:59999", // never contacted
            description: "Auto-derived at add time.",
            authenticationTemplate: [
              {
                slug: "apiKey",
                type: "apiKey",
                headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
              },
            ],
          },
        });

        // The add-time description is what the user first sees.
        const initial = yield* apiClient.integrations.get({ params: { slug } });
        expect(initial.description, "the add-time description is stored").toBe(
          "Auto-derived at add time.",
        );

        // Rename and re-describe the integration — the curate step.
        const renamed = yield* apiClient.integrations.update({
          params: { slug },
          payload: { name: "Acme Ping", description: "Hand-curated for the team." },
        });
        expect(renamed.name, "the update response carries the new name").toBe("Acme Ping");
        expect(renamed.description, "the update response carries the new description").toBe(
          "Hand-curated for the team.",
        );

        // It persists for the next reader, not just in the response.
        const reread = yield* apiClient.integrations.get({ params: { slug } });
        expect(reread.name, "the name persisted").toBe("Acme Ping");
        expect(reread.description, "the description persisted").toBe("Hand-curated for the team.");

        // A connection carries its own editable description.
        const providers = yield* apiClient.providers.list();
        yield* apiClient.connections.create({
          payload: {
            owner: "org",
            name: connectionName,
            integration: slug,
            template: AuthTemplateSlug.make("apiKey"),
            from: { provider: providers[0]!, id: ProviderItemId.make(randomUUID()) },
          },
        });
        const describedConnection = yield* apiClient.connections.update({
          params: { owner: "org", integration: slug, name: connectionName },
          payload: { description: "Prod key, rotates quarterly." },
        });
        expect(describedConnection.description, "the connection description was set").toBe(
          "Prod key, rotates quarterly.",
        );

        const connectionReread = yield* apiClient.connections.get({
          params: { owner: "org", integration: slug, name: connectionName },
        });
        expect(connectionReread.description, "the connection description persisted").toBe(
          "Prod key, rotates quarterly.",
        );
      }),
      Effect.gen(function* () {
        yield* apiClient.connections
          .remove({ params: { owner: "org", integration: slug, name: connectionName } })
          .pipe(Effect.ignore);
        yield* apiClient.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
      }),
    );
  }),
);
