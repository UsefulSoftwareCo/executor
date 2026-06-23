// Health checks for the Google provider plugin. Provider integrations wire the
// OpenAPI health-check backing and auto-configure a default identity check
// (People API `people.get`) at add time, so a connection reports alive/expired +
// identity out of the box. Here we pin the auto-default + the typed candidate the
// editor would show; the probe itself is the shared OpenAPI path exercised by
// health-checks.ts.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { Effect } from "effect";
import { expect } from "@effect/vitest";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { googleHttpPlugin } from "@executor-js/plugin-google/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([googleHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const newSlug = (prefix: string) =>
  IntegrationSlug.make(`${prefix}-${randomBytes(4).toString("hex")}`);

/** A minimal Google Discovery document for the People API, served locally so
 *  `addBundle` (which fetches the discovery URL) is hermetic. `people.get` is the
 *  canonical identity call; its response carries `emailAddresses[].value`. */
const peopleDiscoveryDoc = (): string =>
  JSON.stringify({
    kind: "discovery#restDescription",
    name: "people",
    version: "v1",
    title: "People API",
    rootUrl: "https://people.example.com/",
    servicePath: "",
    auth: {
      oauth2: {
        scopes: {
          "https://www.googleapis.com/auth/userinfo.email": { description: "See your email" },
        },
      },
    },
    resources: {
      people: {
        methods: {
          get: {
            id: "people.people.get",
            httpMethod: "GET",
            path: "v1/{resourceName}",
            scopes: ["https://www.googleapis.com/auth/userinfo.email"],
            parameters: {
              resourceName: { location: "path", required: true, type: "string" },
              personFields: { location: "query", type: "string" },
            },
            response: { $ref: "Person" },
          },
        },
      },
    },
    schemas: {
      Person: {
        id: "Person",
        type: "object",
        properties: {
          resourceName: { type: "string" },
          emailAddresses: { type: "array", items: { $ref: "EmailAddress" } },
          names: { type: "array", items: { $ref: "Name" } },
        },
      },
      EmailAddress: {
        id: "EmailAddress",
        type: "object",
        properties: { value: { type: "string" } },
      },
      Name: { id: "Name", type: "object", properties: { displayName: { type: "string" } } },
    },
  });

/** Serve the People discovery doc at a `/people/`-containing path (so the plugin
 *  recognizes the bundle as containing the People API). */
const servePeopleDiscovery = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly discoveryUrl: string; readonly close: () => void }>((resume) => {
      const doc = peopleDiscoveryDoc();
      const server = createServer((request, response) => {
        if ((request.url ?? "").includes("/apis/people/")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(doc);
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            discoveryUrl: `http://127.0.0.1:${port}/discovery/v1/apis/people/v1/rest`,
            close: () => {
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(server.close),
  );

scenario(
  "Health checks · adding a Google People bundle auto-configures the identity check",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client: Client = yield* makeClient(api, identity);
      const discovery = yield* servePeopleDiscovery();
      const slug = newSlug("hc-google");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.google.addBundle({
            payload: { urls: [discovery.discoveryUrl], slug: String(slug) },
          });

          // The People identity call is offered as a candidate, with its typed
          // response fields (so the editor's identity picker lists the email).
          const candidates = yield* client.integrations.healthCheckCandidates({ params: { slug } });
          const peopleGet = candidates.find((candidate) => candidate.method === "get");
          if (!peopleGet) return yield* Effect.die("People bundle exposed no GET candidate");
          expect(
            (peopleGet.responseFields ?? []).map((field) => field.path),
            "the email identity field is projected from the response schema",
          ).toContain("emailAddresses.0.value");

          // Adding the bundle auto-wrote the default identity health check: the
          // People identity call, with the required pinned args and email field.
          const stored = yield* client.integrations.healthCheckGet({ params: { slug } });
          expect(stored?.operation, "the default check targets the People identity call").toBe(
            peopleGet.operation,
          );
          expect(stored?.identityField, "the default reads the email field").toBe(
            "emailAddresses.0.value",
          );
          expect(stored?.args, "the People call's required args are pinned").toEqual({
            resourceName: "people/me",
            personFields: "names,emailAddresses",
          });
        }),
        client.google.removeBundle({ params: { slug: String(slug) } }).pipe(Effect.ignore),
      );
    }),
  ),
);
