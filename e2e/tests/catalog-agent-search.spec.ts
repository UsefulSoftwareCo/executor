/**
 * Agents search the official app catalog instead of reading it whole, and an install or MCP import
 * an agent cannot finish is refused with the steps it takes next. An Executor app still built on
 * `apps` beta.9 refuses the filters from a catalog document it cached before them, and a pin-only
 * redeploy, as `5_redeploy_pre_beta10_executor_apps` makes, accepts them at once.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { publishedRelease } from "../support/app-package.ts";
import { catalogDocumentUpstream } from "../support/catalog-document-upstream.ts";
import { Inventory } from "../support/contracts.ts";
import { frameworkSession } from "../support/framework.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { officialApps } from "../support/public-catalogs.ts";
import { scenarios } from "../test-plan.ts";

const Catalog = Schema.Array(Schema.Struct({ id: Schema.String, package: Schema.String }));
/** The dashboards' session listing: the same entries, with the feed's state beside them. */
const SessionCatalog = Schema.Struct({
  apps: Catalog,
  feed: Schema.Struct({ status: Schema.Literal("listed") }),
});
const Recovery = Schema.Struct({ action: Schema.String, instructions: Schema.String });
const Rejected = Schema.Struct({
  _tag: Schema.Literal("CatalogImportFailed"),
  code: Schema.String,
  reason: Schema.String,
  recovery: Recovery,
});
const ToolFailure = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      response: Schema.Struct({
        code: Schema.String,
        status: Schema.Number,
        message: Schema.String,
        recovery: Recovery,
      }),
    }),
  }),
});
const Operation = Schema.Struct({
  description: Schema.String,
  parameters: Schema.optional(Schema.Array(Schema.Unknown)),
});
const Found = Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) });
const catalogPath = "/api/organizations/{organization}/catalog";
const installPath = "/api/organizations/{organization}/apps/install";
const importPath = "/api/organizations/{organization}/apps/import";
const Document = Schema.Struct({
  paths: Schema.Struct({
    [catalogPath]: Schema.Struct({ get: Operation }),
    [installPath]: Schema.Struct({ post: Operation }),
    [importPath]: Schema.Struct({ post: Operation }),
  }),
});
const feedIds = [officialApps.mail.id, officialApps.tracker.id, officialApps.mismatched.id];

layer(HostedLive, { excludeTestServices: true })("Catalog agent search", (it) => {
  it.effect(scenarios.catalogAgentSearch.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const list = (query: string) =>
          api
            .request(actors.owner, "GET", `${prefix}/catalog${query}`)
            .pipe(Effect.flatMap((response) => body(Catalog, response)));
        const ids = (query: string) =>
          list(query).pipe(Effect.map((entries) => entries.map((entry) => entry.id)));

        // Without filters, every entry in the catalog's order; a blank search is the same listing.
        const all = yield* ids("");
        expect(all.slice(1)).toEqual(feedIds);
        expect(yield* ids("?search=%20%20")).toEqual(all);
        expect(yield* ids("?limit=1000")).toEqual(all);
        // A search is trimmed and case-insensitive, matches id, name or package, and keeps order.
        expect(yield* ids("?search=%20SYNTHETIC%20")).toEqual(feedIds);
        expect(yield* ids("?search=tracker")).toEqual([officialApps.tracker.id]);
        expect(yield* ids(`?search=${encodeURIComponent(officialApps.mail.package)}`)).toEqual([
          officialApps.mail.id,
        ]);
        expect(yield* ids("?search=synthetic&limit=2")).toEqual(feedIds.slice(0, 2));
        expect(yield* ids("?search=no-such-app")).toEqual([]);
        for (const limit of ["0", "-1", "1.5", "1001", "abc"]) {
          const response = yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/catalog?limit=${limit}`,
          );
          expect(response.status, `limit=${limit}`).toBe(400);
        }
        // The session catalog the dashboard reads takes the same filters.
        expect(
          (yield* body(
            SessionCatalog,
            yield* api.request(actors.owner, "GET", "/api/catalog?search=tracker"),
          )).apps.map((entry) => entry.id),
        ).toEqual([officialApps.tracker.id]);

        // A server URL is not a catalog entry: install says so and names the custom MCP import,
        // without repeating the URL. An unlisted id gets the same steps.
        const serverUrl = "https://mcp.example.com/mcp";
        const installRefused = (entry: string) =>
          Effect.gen(function* () {
            const name = `Install refused ${randomUUID().slice(0, 8)}`;
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/install`, {
              entry,
              name,
            });
            expect(response.status, JSON.stringify(response.body)).toBe(422);
            const inventory = yield* body(
              Inventory,
              yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
            );
            expect(inventory.apps.map((app) => app.name)).not.toContain(name);
            return {
              rejected: yield* body(Rejected, response),
              raw: JSON.stringify(response.body),
            };
          });
        const byUrl = yield* installRefused(serverUrl);
        expect(byUrl.rejected.code).toBe("entry_missing");
        expect(byUrl.rejected.reason).toContain("This URL is not a catalog entry.");
        expect(byUrl.rejected.recovery.instructions).toContain("apps.importCustom");
        expect(byUrl.rejected.recovery.instructions).toContain('kind: "mcp"');
        expect(byUrl.raw).not.toContain(serverUrl);
        const unlisted = yield* installRefused("synthetic-unlisted");
        expect(unlisted.rejected.code).toBe("entry_missing");
        expect(unlisted.rejected.reason).toContain("no longer in the catalog");
        expect(unlisted.rejected.recovery).toEqual(byUrl.rejected.recovery);

        // The tools an agent reads describe the filters, install and the custom MCP import.
        const document = yield* body(
          Document,
          yield* api.request(actors.owner, "GET", "/openapi.json"),
        );
        const catalogTool = document.paths[catalogPath].get;
        expect(catalogTool.description).toContain("pass search, and limit");
        const parameters = JSON.stringify(catalogTool.parameters);
        expect(parameters).toContain("matched as a substring of each entry's id, name or package");
        expect(parameters).toContain("a whole number from 1 to 1000");
        expect(document.paths[installPath].post.description).toContain(
          "refused with entry_missing",
        );
        expect(document.paths[importPath].post.description).toContain(
          "Add a remote MCP server by its URL",
        );
        expect(document.paths[importPath].post.description).toContain("appAccounts.userConnect");

        // An agent does the same through MCP: it searches, then follows the refusal's recovery.
        const { client, execute, queries } = yield* frameworkSession;
        // An agent asking how to add an app finds the catalog, install and the custom import.
        for (const query of ["Quick Add", "add an app from the catalog"]) {
          const found = yield* Schema.decodeUnknownEffect(Found)(
            yield* execute(`return await tools.search({ query: ${JSON.stringify(query)} });`),
          );
          expect(
            found.items.slice(0, 5).map((item) => item.path),
            query,
          ).toEqual(
            expect.arrayContaining(
              ["apps.importCustom", "organization.catalog", "apps.install"].map(
                (tool) => `${queries}.${tool}`,
              ),
            ),
          );
        }
        const organization = JSON.stringify({ organization: actors.organization.id });
        const searched = yield* Schema.decodeUnknownEffect(Catalog)(
          yield* execute(
            `return await ${queries}.organization.catalog({ path: ${organization}, query: { search: "TRACKER", limit: "1" } });`,
          ),
        );
        expect(searched.map((entry) => entry.id)).toEqual([officialApps.tracker.id]);
        const refused = yield* client
          .use("Install a server URL through MCP", (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await ${queries}.apps.install({ path: ${organization}, body: { entry: ${JSON.stringify(serverUrl)}, name: "MCP install by URL" } });`,
                },
              },
              undefined,
              { signal },
            ),
          )
          .pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(ToolFailure)(result.structuredContent),
            ),
            Effect.map((result) => result.execution.error.response),
          );
        expect(refused).toMatchObject({ code: "CatalogImportFailed", status: 422 });
        expect(refused.message).toContain("[entry_missing]");
        // Install is a write, so the Executor app adds its own advice, but the steps the API
        // gave reach the agent whole inside it.
        expect(refused.recovery.instructions).toContain(byUrl.rejected.recovery.action);
        expect(refused.recovery.instructions).toContain(byUrl.rejected.recovery.instructions);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
const Fields = Schema.Record(Schema.String, Schema.Unknown);
const Published = Schema.Struct({
  openapi: Schema.String,
  paths: Schema.Struct({ [catalogPath]: Schema.Struct({ get: Fields }) }),
  components: Fields,
});
const Parameters = Schema.Array(Fields);
const DeployedApp = Schema.Struct({ id: Schema.String });
const Refused = Schema.Struct({
  _tag: Schema.Literal("InputInvalid"),
  problems: Schema.Array(Schema.String),
});

/** The release `5_redeploy_pre_beta10_executor_apps` pins; it still builds beta.9's source. */
const redeployRelease = "0.0.1-beta.84";

/**
 * The Executor app's document handling, as its template writes it, without its account: the
 * document at `origin` with the default cache windows, and calls sent to `origin`.
 */
const documentApp = (origin: string, apps: string) => [
  {
    path: "index.ts",
    content: `import { defineApp } from "apps";
import { liveOpenapiRouter } from "apps/openapi";

export default defineApp({ accounts: {} }, async (context) => ({
  tools: liveOpenapiRouter({
    source: { url: ${JSON.stringify(`${origin}/openapi.json`)} },
    allowedOrigin: ${JSON.stringify(origin)},
    baseUrl: ${JSON.stringify(origin)},
    securitySchemes: {},
    methods: {},
    oauth: [],
    cache: context.cache,
    fetch: context.fetch,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  }),
}));
`,
  },
  {
    path: "package.json",
    content: JSON.stringify(
      { name: "executor", private: true, type: "module", dependencies: { apps } },
      null,
      2,
    ),
  },
];

layer(HostedLive, { excludeTestServices: true })("Catalog document cached on beta.9", (it) => {
  it.effect(scenarios.catalogCachedDocument.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // This server's catalog operation, and the same operation as servers published it before
        // the filters: no query parameters. The fixture app takes no account.
        const published = yield* body(
          Published,
          yield* api.request(actors.owner, "GET", "/openapi.json"),
        );
        const { security: _, ...operation } = published.paths[catalogPath].get;
        const parameters = yield* Schema.decodeUnknownEffect(Parameters)(operation.parameters);
        const filters = parameters.filter((parameter) => parameter.in === "query");
        expect(filters.length).toBeGreaterThan(0);
        const before = {
          ...operation,
          parameters: parameters.filter((parameter) => parameter.in !== "query"),
        };
        const document = (get: unknown) => (origin: string) => ({
          openapi: published.openapi,
          info: { title: "Executor", version: "1" },
          servers: [{ url: origin }],
          paths: { [catalogPath]: { get } },
          components: published.components,
        });
        const upstream = yield* catalogDocumentUpstream(document(before));

        const release = yield* publishedRelease("0.0.1-beta.9");
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Executor document ${randomUUID().slice(0, 8)}`,
          files: documentApp(upstream.origin, release.url),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        expect((yield* release.requests)[release.route]).toBeGreaterThan(0);
        const app = yield* body(DeployedApp, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const organization = { organization: actors.organization.id };
        const list = (input: unknown) =>
          api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool: "organization.catalog",
            input,
          });
        const filtered = { path: organization, query: { search: "mail", limit: "2" } };
        const refused = (label: string) =>
          list(filtered).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status, label).toBe(422))),
            Effect.flatMap((response) => body(Refused, response)),
            Effect.map((response) => response.problems.join("\n")),
          );

        // The beta.9 app caches the document from before the filters. Unfiltered calls work; a
        // filtered call is refused before it is sent.
        const unfiltered = yield* list({ path: organization });
        expect(unfiltered.status, JSON.stringify(unfiltered.body)).toBe(200);
        // beta.9's schema closes the input, so the filters' `query` key is refused by name.
        expect(yield* refused("Filters on the cached document")).toBe(
          'input.query: Failed the "false" constraint',
        );
        expect(yield* upstream.queries).toEqual([""]);
        expect(yield* upstream.downloads).toBe(1);

        // The server then publishes the filters. Inside the 5-minute fresh window the app keeps its
        // cached document, so the filters stay refused. This does not cross the window, so it does
        // not show beta.9's aborted background refresh (#1148): a loopback refresh finishes before
        // the invocation ends, and with a 1-second window beta.9 refreshed as beta.14 does.
        yield* upstream.publish(document(operation));
        expect(yield* refused("Filters after the server published them")).toBe(
          'input.query: Failed the "false" constraint',
        );
        expect(yield* upstream.queries).toEqual([""]);
        expect(yield* upstream.downloads).toBe(1);

        // The data step's redeploy changes only the framework pin, to `redeployRelease`. The new
        // build starts with an empty cache, so the next call reads the published document and the
        // filters work.
        const redeployed = yield* saveAndDeploy(actors.owner, path, {
          files: documentApp(upstream.origin, redeployRelease),
        });
        expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
        const accepted = yield* list(filtered);
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
        expect(yield* upstream.queries).toEqual(["", "?search=mail&limit=2"]);
        expect(yield* upstream.downloads).toBe(2);
      }),
    ),
  );
});
