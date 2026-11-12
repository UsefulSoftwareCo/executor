/** App names that storage cannot hold or that would list as blank are refused, not stored or failed. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({ id: Schema.String, name: Schema.String });

/** A NUL cannot be stored, a newline breaks the one-line name, and invisible text lists as blank. */
const refused = ["Zero\u0000Width", "Two\nlines", "Tabbed\tname", "\u200b\u200b", "\u200d"];

layer(HostedLive, { excludeTestServices: true })("App name validation", (it) => {
  it.effect(scenarios.appNameValidation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const issuer = yield* oauthSetupIssuer;
        yield* issuer.configure({ serveMcp: true });
        const prefix = `/api/organizations/${actors.organization.id}`;
        const suffix = randomUUID().slice(0, 8);
        const url = `${issuer.origin}/mcp`;

        const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
          source: { kind: "mcp", name: `Named ${suffix}`, url },
        });
        expect(imported.status, JSON.stringify(imported.body)).toBe(200);
        const app = yield* body(App, imported);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const appPath = `${prefix}/apps/${app.id}`;

        for (const name of refused) {
          const label = JSON.stringify(name);
          // Quick add and rename both refuse the name as a bad request, never a storage error.
          const add = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
            source: { kind: "mcp", name, url },
          });
          expect(add.status, `import ${label}: ${JSON.stringify(add.body)}`).toBe(400);
          const rename = yield* api.request(actors.owner, "PATCH", `${appPath}/name`, { name });
          expect(rename.status, `rename ${label}: ${JSON.stringify(rename.body)}`).toBe(400);
        }
        const unchanged = yield* body(App, yield* api.request(actors.owner, "GET", appPath));
        expect(unchanged.name).toBe(`Named ${suffix}`);

        // Names in other scripts, with accents or joined emoji, stay valid.
        const kept = `Café 日本語 👨‍👩‍👧 ${suffix}`;
        const renamed = yield* api.request(actors.owner, "PATCH", `${appPath}/name`, {
          name: kept,
        });
        expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
        const read = yield* body(App, yield* api.request(actors.owner, "GET", appPath));
        expect(read.name).toBe(kept);
      }),
    ),
  );
});
