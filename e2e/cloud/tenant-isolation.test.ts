// Cloud-only: the tenant partition itself. The per-request executor binds the
// caller's organization from auth — a request can't even NAME a foreign org —
// so the invariant is that everything written under one org (integrations,
// tools, connections, secret values) is simply invisible from another org, and
// that the same integration slug in two orgs is two independent records.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const TEMPLATE_API_KEY = AuthTemplateSlug.make("apiKey");

/** Minimal OpenAPI spec with a single GET /ping — never contacted here. */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Ping API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: { operationId: "ping", summary: "Ping", responses: { "200": { description: "pong" } } },
    },
  },
});

const addPingSpec = (client: Client, slug: IntegrationSlug, description?: string) =>
  client.openapi.addSpec({
    payload: {
      spec: { kind: "blob", value: pingSpec },
      slug,
      ...(description === undefined ? {} : { description }),
      baseUrl: "http://127.0.0.1:59999", // never contacted during registration
      authenticationTemplate: [
        {
          slug: "apiKey",
          type: "apiKey",
          headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
        },
      ],
    },
  });

scenario(
  "Tenant isolation · integrations, tools, and connections in one org are invisible to another",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const orgA = yield* target.newIdentity();
    const orgB = yield* target.newIdentity();
    const clientA = yield* client(api, orgA);
    const clientB = yield* client(api, orgB);

    const slug = IntegrationSlug.make(`tenant-scn-${randomBytes(4).toString("hex")}`);
    const connectionName = ConnectionName.make(`tenantconn${randomBytes(4).toString("hex")}`);
    const secretValue = `tenant-secret-${randomBytes(8).toString("hex")}`;

    // Org A registers an integration and stores a credential against it.
    yield* addPingSpec(clientA, slug);
    yield* clientA.connections.create({
      payload: {
        owner: "org",
        name: connectionName,
        integration: slug,
        template: TEMPLATE_API_KEY,
        value: secretValue,
      },
    });

    // Sanity from org A's own side: the integration is really there.
    const aIntegrations = yield* clientA.integrations.list();
    expect(
      aIntegrations.map((integration) => integration.slug),
      "org A sees its own integration",
    ).toContain(slug);

    // Org B sees none of it — catalog, tools, connections, or secret bytes.
    const bIntegrations = yield* clientB.integrations.list();
    expect(
      bIntegrations.map((integration) => integration.slug),
      "org B's integration catalog has no trace of org A's integration",
    ).not.toContain(slug);

    const bTools = yield* clientB.tools.list({ query: {} });
    const leakedTools = bTools
      .filter((tool) => String(tool.address).includes(slug))
      .map((tool) => tool.address);
    expect(leakedTools, "no org-A tool leaks into org B's tool catalog").toEqual([]);

    const bView = yield* clientB.openapi.getIntegration({ params: { slug } });
    expect(bView, "fetching org A's integration by slug from org B yields nothing").toBeNull();

    const bConnections = yield* clientB.connections.list({ query: {} });
    expect(
      bConnections.map((connection) => connection.name),
      "org A's connection is not in org B's connection list",
    ).not.toContain(connectionName);
    expect(
      JSON.stringify(bConnections),
      "org A's secret value appears nowhere in org B's view",
    ).not.toContain(secretValue);
  }),
);

scenario(
  "Tenant isolation · the same integration slug in two orgs is two independent records",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const orgA = yield* target.newIdentity();
    const orgB = yield* target.newIdentity();
    const clientA = yield* client(api, orgA);
    const clientB = yield* client(api, orgB);

    // Both orgs register the SAME slug — neither blocks the other.
    const slug = IntegrationSlug.make(`shared-scn-${randomBytes(4).toString("hex")}`);
    yield* addPingSpec(clientA, slug, "Org A API");
    yield* addPingSpec(clientB, slug, "Org B API");

    // Updating org A's record must not mutate org B's same-slug record.
    yield* clientA.integrations.update({
      params: { slug },
      payload: { description: "Org A Updated API" },
    });

    const aIntegration = yield* clientA.integrations.get({ params: { slug } });
    const bIntegration = yield* clientB.integrations.get({ params: { slug } });
    expect(aIntegration.description, "org A sees its own update").toBe("Org A Updated API");
    expect(bIntegration.description, "org B's same-slug record is untouched").toBe("Org B API");
  }),
);
