/** No-code URL imports call the published GitHub emulator through ordinary product accounts. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Inventory } from "../support/contracts.ts";
import { apiUrlImports } from "../support/api-url-import.ts";
import { apiUrlUpstream } from "../support/api-url-upstream.ts";

layer(HostedLive, { excludeTestServices: true })("API URL imports", (it) => {
  it.effect(scenarios.apiUrlImportOpenapi.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors,
          upstream = yield* apiUrlUpstream;
        const imports = yield* apiUrlImports;
        const token = Redacted.value(upstream.token);
        yield* browser.login(actors.owner);
        for (const source of [
          { name: "JSON", url: upstream.openapi },
          { name: "YAML", url: upstream.yaml, baseUrl: upstream.origin },
        ]) {
          const path = yield* imports.importInBrowser({
            kind: "OpenAPI",
            ...source,
            name: `API URL ${source.name} ${randomUUID().slice(0, 8)}`,
          });
          const account = yield* imports.connect(path, token);
          yield* imports.retained(path, source.url, token);
          yield* imports.call(path, "getAuthenticatedUser", account, upstream.login);
          yield* browser.checkpoint(
            `OpenAPI ${source.name} URL imported, account connected and emulator user read`,
          );
        }
      }),
    ),
  );

  it.effect(scenarios.apiUrlImportGraphql.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors,
          upstream = yield* apiUrlUpstream;
        const imports = yield* apiUrlImports;
        const token = Redacted.value(upstream.token);
        yield* browser.login(actors.owner);
        for (const auth of ["Bearer token", "API key header"] as const) {
          const path = yield* imports.importInBrowser({
            kind: "GraphQL",
            name: `API URL GraphQL ${randomUUID().slice(0, 8)}`,
            url: upstream.graphql,
            auth,
          });
          const account = yield* imports.connect(
            path,
            auth === "Bearer token" ? token : `Bearer ${token}`,
          );
          yield* imports.retained(path, upstream.graphql, token);
          yield* imports.call(path, "query_viewer", account, upstream.login);
          yield* browser.checkpoint(
            `GraphQL URL imported with ${auth}, account connected and emulator viewer read`,
          );
        }
      }),
    ),
  );

  it.effect(scenarios.apiUrlImportRejected.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          upstream = yield* apiUrlUpstream;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const rejected: string[] = [];
        for (const input of [
          { url: upstream.invalid, status: 422 },
          {
            url: upstream.openapi.replace("https://", "https://synthetic:credential@"),
            status: 400,
          },
          { url: "http://169.254.169.254/openapi.json", status: 422 },
        ]) {
          const name = `Rejected URL ${randomUUID().slice(0, 8)}`;
          rejected.push(name);
          const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
            source: { kind: "openapi", name, url: input.url },
          });
          expect(response.status, JSON.stringify(response.body)).toBe(input.status);
        }
        const partialName = `Partial API ${randomUUID().slice(0, 8)}`;
        rejected.push(partialName);
        const partial = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
          source: { kind: "openapi", name: partialName, url: upstream.partial },
        });
        expect(partial.status, JSON.stringify(partial.body)).toBe(422);
        expect(JSON.stringify(partial.body)).toContain("Some API operations are unsupported");
        const inventory = yield* body(
          Inventory,
          yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
        );
        for (const name of rejected)
          expect(inventory.apps.map((app) => app.name)).not.toContain(name);
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
          source: { kind: "graphql", name: "Invalid GraphQL", url: upstream.invalid },
        });
        expect(response.status, JSON.stringify(response.body)).toBe(422);
        expect(JSON.stringify(response.body)).not.toContain(upstream.invalid);
      }),
    ),
  );
});
