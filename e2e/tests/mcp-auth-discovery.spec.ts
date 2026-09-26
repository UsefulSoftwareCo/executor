/** Quick add checks the MCP server itself; only public and OAuth servers are added directly. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Inventory, Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { publicTemplateUpstream } from "../support/template-upstream.ts";
import { scenarios } from "../test-plan.ts";

const Requirements = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({ accounts: Schema.Record(Schema.String, Schema.Unknown) }),
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
          actors = yield* Actors;
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

        // The challenge may arrive on GET or only on the MCP initialization POST.
        for (const postChallenge of [true, false]) {
          yield* issuer.configure({ postChallenge, challenge: true, discovery: "available" });
          const probes = (yield* issuer.metrics).probes;
          const app = yield* added(
            yield* add(`Discovery ${randomUUID().slice(0, 8)}`, `${issuer.origin}/mcp`),
          );
          expect((yield* issuer.metrics).probes, "Quick add checks the server").toBeGreaterThan(
            probes,
          );
          expect(Object.keys(app.requirements.accounts)).toEqual(["service"]);
          const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
              requirement: "service",
              profile: profile.id,
            }),
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
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/cancel`,
            {},
          );
        }

        // A public server initializes anonymously and needs no account.
        const open = yield* publicTemplateUpstream;
        const publicApp = yield* added(
          yield* add(`Public ${randomUUID().slice(0, 8)}`, `${open}/mcp`),
        );
        expect(publicApp.requirements.accounts).toEqual({});

        // Rejecting anonymous use without discoverable OAuth means an API key or other setup.
        yield* issuer.configure({ challenge: false, postChallenge: true, discovery: "missing" });
        const keyed = `Needs a key ${randomUUID().slice(0, 8)}`;
        const setup = yield* add(keyed, `${issuer.origin}/mcp`);
        expect(setup.status).toBe(422);
        expect((yield* body(Rejected, setup)).code).toBe("agent_setup_required");
        yield* notAdded(keyed);

        // A failing server is a retryable check failure, not a reason to guess a method.
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
