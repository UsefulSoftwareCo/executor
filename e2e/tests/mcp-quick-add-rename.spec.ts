/** A quick-added OAuth MCP app's provider is named after its server, so renaming the app keeps it. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { connectionsPath, linkedAccountIds } from "../support/app-accounts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Record(
      Schema.String,
      Schema.Struct({
        provider: Schema.String,
        definition: Schema.Struct({ name: Schema.String }),
      }),
    ),
  }),
});
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });

layer(HostedLive, { excludeTestServices: true })("MCP quick add rename", (it) => {
  it.effect(scenarios.mcpQuickAddRename.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        yield* issuer.configure({ serveMcp: true });
        const prefix = `/api/organizations/${actors.organization.id}`;
        const suffix = randomUUID().slice(0, 8);
        const host = new URL(issuer.origin).host;

        const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
          source: { kind: "mcp", name: `Misnamed ${suffix}`, url: `${issuer.origin}/mcp` },
        });
        expect(imported.status, JSON.stringify(imported.body)).toBe(200);
        const app = yield* body(App, imported);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const before = app.requirements.accounts.service;
        if (before === undefined) return yield* Effect.die("The OAuth app declares no account");
        // The provider is named after the server, not the app the user named.
        expect(before.definition.name).toBe(host);
        const source = yield* body(
          Source,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/source`),
        );
        const provider = source.files.find((file) => file.path === "provider.ts")?.content;
        expect(provider).toContain(`name: "${host}"`);
        expect(provider).not.toContain("Misnamed");

        // Connect an account for the app through the server's OAuth.
        const appPath = `${prefix}/apps/${app.id}`;
        const connection = (yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", connectionsPath(appPath, "user", "service"), {
            destination: { kind: "personal" },
          }),
        )).id;
        const started = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection}/oauth/start`,
          { method: "oauth", label: "Quick add account" },
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const authorizationUrl = (yield* body(SignIn, started)).authorizationUrl;
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
            expect(consent.status).toBe(302);
            const location = consent.headers.location;
            if (location === undefined) return yield* Effect.die("No callback");
            return location;
          }),
        ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const completed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection}/oauth/complete`,
          { callbackUrl },
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const linked = yield* linkedAccountIds(actors.owner, appPath);
        expect(linked).toHaveLength(1);

        // Renaming the app keeps its provider, the provider's name and the linked account.
        const renamed = yield* api.request(actors.owner, "PATCH", `${appPath}/name`, {
          name: `Correct ${suffix}`,
        });
        expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
        const read = yield* body(App, yield* api.request(actors.owner, "GET", appPath));
        expect(read.name).toBe(`Correct ${suffix}`);
        expect(read.requirements.accounts.service).toEqual(before);
        expect(yield* linkedAccountIds(actors.owner, appPath)).toEqual(linked);
      }),
    ),
  );
});
