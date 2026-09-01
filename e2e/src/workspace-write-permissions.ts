import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import type { Identity, Target as TargetShape } from "./target";
import { Api } from "./services";

const api = composePluginApi([openApiHttpPlugin()] as const);
const TEMPLATE = AuthTemplateSlug.make("apiKey");

const unique = (prefix: string): string => `${prefix}-${randomBytes(4).toString("hex")}`;

const specPayload = (slug: IntegrationSlug) => ({
  spec: {
    kind: "blob" as const,
    value: JSON.stringify({
      openapi: "3.0.3",
      info: { title: `Permissions ${slug}`, version: "1.0.0" },
      paths: {
        "/ping": {
          get: {
            operationId: "ping",
            tags: ["ping"],
            responses: { "200": { description: "pong" } },
          },
        },
      },
    }),
  },
  slug,
  baseUrl: "http://127.0.0.1:59999",
  authenticationTemplate: [
    {
      slug: TEMPLATE,
      type: "apiKey" as const,
      headers: { authorization: ["Bearer ", { type: "variable" as const, name: "token" }] },
    },
  ],
});

const request = (
  target: TargetShape,
  identity: Identity,
  method: string,
  path: string,
  body?: unknown,
): Effect.Effect<Response> =>
  Effect.promise(() =>
    fetch(new URL(path, target.baseUrl), {
      method,
      headers: {
        ...(identity.headers ?? {}),
        origin: new URL(target.baseUrl).origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const expectForbidden = (
  target: TargetShape,
  member: Identity,
  label: string,
  method: string,
  path: string,
  body?: unknown,
): Effect.Effect<void> =>
  request(target, member, method, path, body).pipe(
    Effect.map((response) => {
      expect(response.status, `${label} is denied at the HTTP boundary`).toBe(403);
    }),
  );

/** Exercise the complete workspace-write authorization matrix for one host boot. */
export const workspaceWritePermissions = (target: TargetShape, admin: Identity, member: Identity) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { client: makeClient } = yield* Api;
      const oauth = yield* serveOAuthTestServer();
      const adminClient = yield* makeClient(api, admin);
      const memberClient = yield* makeClient(api, member);
      const prefix = unique("write-matrix");

      const seedIntegration = IntegrationSlug.make(`${prefix}-seed`);
      const deniedIntegration = IntegrationSlug.make(`${prefix}-denied`);
      const adminIntegration = IntegrationSlug.make(`${prefix}-admin`);
      const connectionSuffix = randomBytes(4).toString("hex");
      const seedConnection = ConnectionName.make(`seed${connectionSuffix}`);
      const deniedConnection = ConnectionName.make(`denied${connectionSuffix}`);
      const personalConnection = ConnectionName.make(`personal${connectionSuffix}`);
      const adminConnection = ConnectionName.make(`admin${connectionSuffix}`);
      const seedClient = OAuthClientSlug.make(`${prefix}-seed`);
      const deniedManualClient = OAuthClientSlug.make(`${prefix}-denied-manual`);
      const deniedDcrClient = OAuthClientSlug.make(`${prefix}-denied-dcr`);
      const adminManualClient = OAuthClientSlug.make(`${prefix}-admin-manual`);
      const adminDcrClient = OAuthClientSlug.make(`${prefix}-admin-dcr`);
      const policyPrefix = `executor.${prefix}`;
      let registeredDynamicClient: OAuthClientSlug | undefined;

      yield* adminClient.openapi.addSpec({ payload: specPayload(seedIntegration) });
      yield* adminClient.connections.create({
        payload: {
          owner: "org",
          name: seedConnection,
          integration: seedIntegration,
          template: TEMPLATE,
          value: `${prefix}-seed-token`,
        },
      });
      yield* adminClient.oauth.createClient({
        payload: {
          owner: "org",
          slug: seedClient,
          grant: "authorization_code",
          authorizationUrl: oauth.authorizationEndpoint,
          tokenUrl: oauth.tokenEndpoint,
          clientId: `${prefix}-seed-id`,
          clientSecret: `${prefix}-seed-secret`,
        },
      });
      const seedPolicy = yield* adminClient.policies.create({
        payload: { owner: "org", pattern: `${policyPrefix}.seed`, action: "approve" },
      });
      const seedIntegrationBefore = yield* adminClient.integrations.get({
        params: { slug: seedIntegration },
      });

      const cleanup = Effect.gen(function* () {
        const policies = yield* adminClient.policies.list();
        yield* Effect.forEach(
          policies.filter((policy) => policy.pattern.startsWith(policyPrefix)),
          (policy) =>
            adminClient.policies
              .remove({ params: { policyId: policy.id }, payload: { owner: "org" } })
              .pipe(Effect.ignore({ log: false })),
          { discard: true },
        );
        const clients = yield* adminClient.oauth.listClients();
        yield* Effect.forEach(
          clients.filter((client) => String(client.slug).startsWith(prefix)),
          (client) =>
            adminClient.oauth
              .removeClient({ params: { slug: client.slug }, payload: { owner: client.owner } })
              .pipe(Effect.ignore({ log: false })),
          { discard: true },
        );
        if (registeredDynamicClient !== undefined) {
          yield* adminClient.oauth
            .removeClient({
              params: { slug: registeredDynamicClient },
              payload: { owner: "org" },
            })
            .pipe(Effect.ignore({ log: false }));
        }
        for (const name of [seedConnection, adminConnection]) {
          yield* adminClient.connections
            .remove({ params: { owner: "org", integration: seedIntegration, name } })
            .pipe(Effect.ignore({ log: false }));
        }
        yield* memberClient.connections
          .remove({
            params: { owner: "user", integration: seedIntegration, name: personalConnection },
          })
          .pipe(Effect.ignore({ log: false }));
        for (const slug of [seedIntegration, deniedIntegration, adminIntegration]) {
          yield* adminClient.openapi
            .removeSpec({ params: { slug } })
            .pipe(Effect.ignore({ log: false }));
        }
      }).pipe(Effect.ignore({ log: false }));

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const connectionPath = `/api/connections/org/${seedIntegration}/${seedConnection}`;
          yield* expectForbidden(
            target,
            member,
            "member org connection create",
            "POST",
            "/api/connections",
            {
              owner: "org",
              name: deniedConnection,
              integration: seedIntegration,
              template: TEMPLATE,
              value: `${prefix}-denied-token`,
            },
          );
          yield* expectForbidden(
            target,
            member,
            "member org connection update",
            "PATCH",
            connectionPath,
            {
              description: "denied",
            },
          );
          yield* expectForbidden(
            target,
            member,
            "member org connection remove",
            "DELETE",
            connectionPath,
          );
          yield* expectForbidden(
            target,
            member,
            "member org connection refresh",
            "POST",
            `${connectionPath}/refresh`,
          );
          const connectionsAfterDenial = yield* adminClient.connections.list({
            query: { owner: "org", integration: seedIntegration },
          });
          expect(
            connectionsAfterDenial.some((connection) => connection.name === deniedConnection),
            "the denied connection create persisted nothing",
          ).toBe(false);
          expect(
            connectionsAfterDenial.find((connection) => connection.name === seedConnection),
            "the denied update/remove left the seeded connection unchanged",
          ).toMatchObject({ description: null, owner: "org" });

          yield* expectForbidden(
            target,
            member,
            "member integration create",
            "POST",
            "/api/openapi/specs",
            specPayload(deniedIntegration),
          );
          yield* expectForbidden(
            target,
            member,
            "member integration update",
            "PATCH",
            `/api/integrations/${seedIntegration}`,
            { description: "denied" },
          );
          yield* expectForbidden(
            target,
            member,
            "member integration remove",
            "DELETE",
            `/api/openapi/integrations/${seedIntegration}`,
          );
          yield* expectForbidden(
            target,
            member,
            "member integration health-check update",
            "PUT",
            `/api/integrations/${seedIntegration}/health-check`,
            { spec: { operation: "ping.ping" } },
          );
          const integrationsAfterDenial = yield* adminClient.integrations.list();
          expect(
            integrationsAfterDenial.some((integration) => integration.slug === deniedIntegration),
            "the denied integration create persisted nothing",
          ).toBe(false);
          expect(
            yield* adminClient.integrations.get({ params: { slug: seedIntegration } }),
            "the denied integration mutations left the seeded integration unchanged",
          ).toEqual(seedIntegrationBefore);

          const manualPayload = {
            owner: "org" as const,
            slug: deniedManualClient,
            grant: "authorization_code" as const,
            authorizationUrl: oauth.authorizationEndpoint,
            tokenUrl: oauth.tokenEndpoint,
            clientId: `${prefix}-denied-id`,
            clientSecret: `${prefix}-denied-secret`,
          };
          yield* expectForbidden(
            target,
            member,
            "member manual OAuth client create",
            "POST",
            "/api/oauth/clients",
            manualPayload,
          );
          yield* expectForbidden(
            target,
            member,
            "member dynamic OAuth client create",
            "POST",
            "/api/oauth/clients/register-dynamic",
            {
              owner: "org",
              slug: deniedDcrClient,
              registrationEndpoint: oauth.registrationEndpoint,
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              scopes: ["read"],
            },
          );
          const clientsAfterDenial = yield* adminClient.oauth.listClients();
          expect(
            clientsAfterDenial.some(
              (client) => client.slug === deniedManualClient || client.slug === deniedDcrClient,
            ),
            "the denied OAuth client creates persisted nothing",
          ).toBe(false);
          expect(
            clientsAfterDenial.some((client) => client.slug === seedClient),
            "the seeded OAuth client survived denied creates",
          ).toBe(true);

          yield* expectForbidden(
            target,
            member,
            "member org policy create",
            "POST",
            "/api/policies",
            { owner: "org", pattern: `${policyPrefix}.denied`, action: "approve" },
          );
          yield* expectForbidden(
            target,
            member,
            "member org policy update",
            "PATCH",
            `/api/policies/${seedPolicy.id}`,
            { owner: "org", action: "block" },
          );
          yield* expectForbidden(
            target,
            member,
            "member org policy remove",
            "DELETE",
            `/api/policies/${seedPolicy.id}`,
            { owner: "org" },
          );
          const policiesAfterDenial = yield* adminClient.policies.list();
          expect(
            policiesAfterDenial.some((policy) => policy.pattern === `${policyPrefix}.denied`),
            "the denied policy create persisted nothing",
          ).toBe(false);
          expect(
            policiesAfterDenial.find((policy) => policy.id === seedPolicy.id),
            "the denied policy update/remove left the seeded policy unchanged",
          ).toMatchObject({ action: "approve", pattern: `${policyPrefix}.seed` });

          const personal = yield* memberClient.connections.create({
            payload: {
              owner: "user",
              name: personalConnection,
              integration: seedIntegration,
              template: TEMPLATE,
              value: `${prefix}-personal-token`,
            },
          });
          expect(personal.owner, "a member may create a Personal connection").toBe("user");
          const personalUpdated = yield* memberClient.connections.update({
            params: { owner: "user", integration: seedIntegration, name: personalConnection },
            payload: { identityLabel: "Personal updated" },
          });
          expect(
            personalUpdated.identityLabel,
            "a member may update their Personal connection",
          ).toBe("Personal updated");
          const personalRemoved = yield* memberClient.connections.remove({
            params: { owner: "user", integration: seedIntegration, name: personalConnection },
          });
          expect(personalRemoved.removed, "a member may remove their Personal connection").toBe(
            true,
          );

          const adminCreated = yield* adminClient.connections.create({
            payload: {
              owner: "org",
              name: adminConnection,
              integration: seedIntegration,
              template: TEMPLATE,
              value: `${prefix}-admin-token`,
            },
          });
          expect(adminCreated.owner, "an admin may create a Workspace connection").toBe("org");
          const adminUpdated = yield* adminClient.connections.update({
            params: { owner: "org", integration: seedIntegration, name: adminConnection },
            payload: { description: "Admin updated" },
          });
          expect(adminUpdated.description, "an admin may PATCH a Workspace connection").toBe(
            "Admin updated",
          );
          const refreshed = yield* adminClient.connections.refresh({
            params: { owner: "org", integration: seedIntegration, name: adminConnection },
          });
          expect(refreshed.length, "an admin may refresh a Workspace connection").toBeGreaterThan(
            0,
          );
          const adminRemoved = yield* adminClient.connections.remove({
            params: { owner: "org", integration: seedIntegration, name: adminConnection },
          });
          expect(adminRemoved.removed, "an admin may remove a Workspace connection").toBe(true);

          yield* adminClient.openapi.addSpec({ payload: specPayload(adminIntegration) });
          const integrationUpdated = yield* adminClient.integrations.update({
            params: { slug: adminIntegration },
            payload: { description: "Admin integration updated" },
          });
          expect(integrationUpdated.description, "an admin may update an integration").toBe(
            "Admin integration updated",
          );
          const healthSet = yield* adminClient.integrations.healthCheckSet({
            params: { slug: adminIntegration },
            payload: { spec: { operation: "ping.ping" } },
          });
          expect(healthSet.ok, "an admin may set an integration health check").toBe(true);
          yield* adminClient.openapi.removeSpec({ params: { slug: adminIntegration } });

          yield* adminClient.oauth.createClient({
            payload: {
              ...manualPayload,
              slug: adminManualClient,
              clientId: `${prefix}-admin-id`,
              clientSecret: `${prefix}-admin-secret`,
            },
          });
          const dynamic = yield* adminClient.oauth.registerDynamic({
            payload: {
              owner: "org",
              slug: adminDcrClient,
              registrationEndpoint: oauth.registrationEndpoint,
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              scopes: ["read"],
            },
          });
          registeredDynamicClient = dynamic.client;
          const dynamicRow = (yield* adminClient.oauth.listClients()).find(
            (client) => client.slug === dynamic.client,
          );
          expect(
            dynamicRow,
            "an admin may dynamically register a persisted Workspace OAuth client",
          ).toMatchObject({
            owner: "org",
            origin: { kind: "dynamic_client_registration" },
          });

          const adminPolicy = yield* adminClient.policies.create({
            payload: { owner: "org", pattern: `${policyPrefix}.admin`, action: "approve" },
          });
          const policyUpdated = yield* adminClient.policies.update({
            params: { policyId: adminPolicy.id },
            payload: { owner: "org", action: "block" },
          });
          expect(policyUpdated.action, "an admin may update a Workspace tool policy").toBe("block");
          const policyRemoved = yield* adminClient.policies.remove({
            params: { policyId: adminPolicy.id },
            payload: { owner: "org" },
          });
          expect(policyRemoved.removed, "an admin may remove a Workspace tool policy").toBe(true);
        }),
        cleanup,
      );
    }),
  );
