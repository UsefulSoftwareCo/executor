// Selfhost · Slice 1: a toolkit is owner-scoped plugin data with a CRUD API.
// Proves the plugin's storage round-trips through real HTTP routes on the
// selfhost server, owner/scope maps correctly, and the scope guard rejects
// connections a toolkit isn't allowed to reference. No MCP narrowing yet.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([toolkitsPlugin()] as const);
const fresh = (prefix: string): string => `${prefix}-${randomBytes(4).toString("hex")}`;

scenario(
  "Toolkits · CRUD round-trips through the selfhost API",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);

    const slug = fresh("work");
    const created = yield* client.toolkits.create({
      payload: {
        slug,
        name: "Work",
        scope: "personal",
        briefing: "general assistant",
      },
    });
    expect(created.slug).toBe(slug);
    expect(created.scope).toBe("personal");
    expect(created.inheritOrgPolicies, "defaults to inheriting org policies").toBe(true);
    expect(created.briefing).toBe("general assistant");
    expect(created.connections.length).toBe(0);

    // round-trips through GET
    const fetched = yield* client.toolkits.get({ params: { id: created.id } });
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe("Work");

    // shows up in the owner-scoped list
    const listed = yield* client.toolkits.list();
    expect(
      listed.some((t) => t.id === created.id),
      "the created toolkit appears in the list",
    ).toBe(true);

    // PATCH mutates name + briefing
    const patched = yield* client.toolkits.update({
      params: { id: created.id },
      payload: { name: "Work v2", briefing: null },
    });
    expect(patched.name).toBe("Work v2");
    expect(patched.briefing).toBe(null);

    // DELETE removes it; subsequent GET is a typed ToolkitNotFound
    const removed = yield* client.toolkits.remove({
      params: { id: created.id },
    });
    expect(removed.removed).toBe(true);

    const afterDelete = yield* Effect.flip(client.toolkits.get({ params: { id: created.id } }));
    expect((afterDelete as { _tag?: string })._tag, "GET after delete is ToolkitNotFound").toBe(
      "ToolkitNotFound",
    );
  }),
);

scenario(
  "Toolkits · a workspace toolkit cannot reference a connection it isn't allowed to use",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);

    const result = yield* Effect.flip(
      client.toolkits.create({
        payload: {
          slug: fresh("support"),
          name: "Support",
          scope: "workspace",
          connections: [
            {
              integration: IntegrationSlug.make("slack"),
              connection: "nope",
              access: "full",
            },
          ],
        },
      }),
    );
    expect((result as { _tag?: string })._tag, "rejected with ToolkitForbidden").toBe(
      "ToolkitForbidden",
    );
  }),
);
