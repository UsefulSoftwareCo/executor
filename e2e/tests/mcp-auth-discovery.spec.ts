import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Inventory, Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { publicTemplateUpstream } from "../support/template-upstream.ts";
import { scenarios } from "../test-plan.ts";
import { connectionsPath } from "../support/app-accounts.ts";

const Requirements = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Record(
      Schema.String,
      Schema.Struct({
        definition: Schema.Struct({ hosts: Schema.optionalKey(Schema.Array(Schema.String)) }),
        health: Schema.optionalKey(Schema.Literal(true)),
      }),
    ),
  }),
});
const Health = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({
      app: Schema.String,
      check: Schema.NullOr(Schema.Struct({ status: Schema.String })),
    }),
  ),
});
const Rejected = Schema.Struct({
  _tag: Schema.Literal("CatalogImportFailed"),
  code: Schema.String,
});

layer(HostedLive, { excludeTestServices: true })("MCP auth discovery", (it) => {
  it.effect(scenarios.mcpAuthDiscovery.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const add = (name: string, url: string) =>
          api.request(actors.owner, "POST", `${prefix}/apps/import`, {
            source: { kind: "mcp", name, url },
          });
        const added = (response: { readonly status: number; readonly body: unknown }) =>
          Effect.gen(function* () {
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(Requirements, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const notAdded = (name: string) =>
          Effect.gen(function* () {
            const inventory = yield* body(
              Inventory,
              yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
            );
            expect(inventory.apps.map((app) => app.name)).not.toContain(name);
          });

        for (const postChallenge of [true, false]) {
          yield* issuer.configure({
            postChallenge,
            challenge: true,
            discovery: "available",
            serveMcp: true,
          });
          const probes = (yield* issuer.metrics).probes;
          const app = yield* added(
            yield* add(`Discovery ${randomUUID().slice(0, 8)}`, `${issuer.origin}/mcp`),
          );
          expect((yield* issuer.metrics).probes, "Quick add checks the server").toBeGreaterThan(
            probes,
          );
          expect(Object.keys(app.requirements.accounts)).toEqual(["service"]);
          expect(
            app.requirements.accounts.service?.definition.hosts,
            "The generated provider sends its tokens only to the server",
          ).toEqual([new URL(issuer.origin).host]);
          expect(
            app.requirements.accounts.service?.health,
            "The generated provider checks accounts against the server",
          ).toBe(true);
          const connection = yield* body(
            Resource,
            yield* api.request(
              actors.owner,
              "POST",
              connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
              {},
            ),
          );
          const start = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/start`,
            { method: "oauth", label: "Synthetic discovery account" },
          );
          expect(start.status, "The generated provider signs in with discovered OAuth").toBe(200);
          const signIn = yield* body(Schema.Struct({ authorizationUrl: Schema.String }), start);
          expect(new URL(signIn.authorizationUrl).pathname).toBe("/authorize");
          const callbackUrl = yield* Effect.scoped(
            Effect.gen(function* () {
              const consent = yield* HttpClient.withScope(http).get(signIn.authorizationUrl);
              expect(consent.status).toBe(302);
              const location = consent.headers.location;
              if (location === undefined)
                return yield* Effect.die("Issuer did not return a callback");
              return location;
            }),
          ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
          const completed = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/complete`,
            { callbackUrl },
          );
          expect(completed.status, JSON.stringify(completed.body)).toBe(200);
          const account = yield* body(Resource, completed);
          const checked = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/accounts/${account.id}/health`,
          );
          expect(checked.status, JSON.stringify(checked.body)).toBe(200);
          expect(
            (yield* body(Health, checked)).apps.find((entry) => entry.app === app.id)?.check
              ?.status,
            "The generated provider checks the account against the server",
          ).toBe("healthy");
        }
        yield* issuer.configure({ serveMcp: false });

        const open = yield* publicTemplateUpstream;
        const publicApp = yield* added(
          yield* add(`Public ${randomUUID().slice(0, 8)}`, `${open}/mcp`),
        );
        expect(publicApp.requirements.accounts).toEqual({});

        yield* issuer.configure({ challenge: false, postChallenge: true, discovery: "missing" });
        const keyed = `Needs a key ${randomUUID().slice(0, 8)}`;
        const setup = yield* add(keyed, `${issuer.origin}/mcp`);
        expect(setup.status).toBe(422);
        expect((yield* body(Rejected, setup)).code).toBe("agent_setup_required");
        yield* notAdded(keyed);

        yield* issuer.configure({ mcpStatus: 520 });
        const failing = `Unavailable ${randomUUID().slice(0, 8)}`;
        const unavailable = yield* add(failing, `${issuer.origin}/mcp`);
        expect(unavailable.status).toBe(422);
        expect((yield* body(Rejected, unavailable)).code).toBe("mcp_probe");
        yield* notAdded(failing);
        yield* issuer.configure({ mcpStatus: null });
      }),
    ),
  );
});
