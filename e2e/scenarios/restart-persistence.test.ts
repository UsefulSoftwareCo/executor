// Cross-target (runs where the target can restart itself — today the
// production Docker artifact): writes survive a process restart. This is the
// durability property a dev-server suite with a fresh data dir can never
// catch by accident, and the one the selfhost WAL split-brain broke: the
// executor's libSQL connection wrote to a WAL that was unlinked during boot
// while Better Auth's connection created a fresh one, so every executor-core
// write (integrations, connections, tools) silently vanished on restart —
// surfacing to users as "my reconnected Google account has zero Gmail tools".
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";

import { scenario } from "../src/scenario";
import { Api, Restart, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

/** OpenAPI 3 spec with a single GET /ping operation. */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Restart Persistence API", version: "1.0.0" },
  servers: [{ url: "http://127.0.0.1:59998" }], // never contacted
  paths: {
    "/ping": {
      get: {
        operationId: "getPing",
        summary: "Liveness ping",
        responses: { "200": { description: "pong" } },
      },
    },
  },
});

scenario(
  "Durability · an integration survives an instance restart",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const restart = yield* Restart;
    const { client } = yield* Api;

    const identity = yield* target.newIdentity();
    const before = yield* client(api, identity);

    const slug = `restart-persist-${randomBytes(4).toString("hex")}`;
    const added = yield* before.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: pingSpec },
        slug,
        authenticationTemplate: [],
      },
    });
    expect(added.toolCount, "the spec registered with tools").toBeGreaterThan(0);

    // The write is visible before the restart — so a post-restart absence is
    // a durability failure, not a registration failure.
    const integrationsBefore = yield* before.integrations.list();
    expect(
      integrationsBefore.map((i) => String(i.slug)),
      "the integration is listed before the restart",
    ).toContain(slug);

    yield* restart();

    // Sessions are DB-backed; sign in fresh anyway so this scenario only
    // asserts on the executor-core rows, not on auth-session survival.
    const after = yield* client(api, yield* target.newIdentity());

    yield* Effect.ensuring(
      Effect.gen(function* () {
        const integrationsAfter = yield* after.integrations.list();
        expect(
          integrationsAfter.map((i) => String(i.slug)),
          "the integration survived the restart",
        ).toContain(slug);
      }),
      // Shared bootstrap-admin instance — never leak the integration, even
      // when the survival assertion fails.
      after.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
    );
  }),
);
