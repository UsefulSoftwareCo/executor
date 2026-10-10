// Cross-target: an upstream 403 that is not about the credential (a feature
// gated by the account's plan, a resource the account may not touch) must not
// tell the caller to re-authenticate. MCP text results carry only
// `code: message`, so the upstream's own reason has to be in the message, or
// the caller is left re-checking a connection that works. A 401 is still a
// rejected credential, and its message carries the upstream reason too.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { decodeToolSearch } from "./support/search-invoke";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

const PLAN_MESSAGE = "feature not available on current billing plan";

/** Upstream on 127.0.0.1: `POST /devices/{id}/attributes/{key}` is gated by
 *  the account's plan (403), `POST /tags` succeeds with the same credential,
 *  and `GET /session` answers 401 for a revoked token. */
const serveUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        const path = request.url ?? "";
        request.resume();
        const send = (status: number, body: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };
        if (request.method === "POST" && path.startsWith("/devices/")) {
          return send(403, { message: PLAN_MESSAGE });
        }
        if (request.method === "POST" && path.startsWith("/tags")) {
          return send(200, { ok: true });
        }
        if (request.method === "GET" && path.startsWith("/session")) {
          return send(401, { message: "token revoked" });
        }
        return send(404, { message: "not found" });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
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

const spec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Devices API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/devices/{id}/attributes/{key}": {
        post: {
          operationId: "setDeviceAttribute",
          tags: ["devices"],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "key", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
      "/tags": {
        post: {
          operationId: "setTags",
          tags: ["devices"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/session": {
        get: {
          operationId: "getSession",
          tags: ["session"],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });

scenario(
  "Auth failures · a plan-gated 403 reports the upstream reason instead of asking to re-authenticate",
  { timeout: 120_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveUpstream();
      const slug = unique("forbid");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: spec(upstream.url) },
              slug,
              baseUrl: upstream.url,
              authenticationTemplate: [
                {
                  slug: "apiKey",
                  type: "apiKey",
                  headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
                },
              ],
            },
          });
          yield* client.connections.create({
            payload: {
              owner: "org",
              name: ConnectionName.make("main"),
              integration: IntegrationSlug.make(slug),
              template: AuthTemplateSlug.make("apiKey"),
              value: "tok_valid",
            },
          });

          const passthrough = mcp.session(identity, { mode: "passthrough", artifacts: false });
          const found = decodeToolSearch(
            (yield* passthrough.call("search", {
              query: slug,
              integration: slug,
              owner: "org",
              connection: "main",
            })).raw,
          ).structuredContent;
          const toolId = (operation: string) => {
            const tool = found.items.find((item) => item.id.endsWith(`.${operation}`));
            expect(tool, `search lists ${operation}`).toBeDefined();
            return tool!.id;
          };

          // The same connection writes fine: the credential is accepted.
          const tagged = yield* passthrough.call("invoke", {
            tool: toolId("setTags"),
            arguments: {},
          });
          expect(tagged.ok, `a write on the same connection succeeds: ${tagged.text}`).toBe(true);

          // THE guarantee: the plan-gated 403 text names the upstream's reason
          // and status, and does not blame the credential.
          const gated = yield* passthrough.call("invoke", {
            tool: toolId("setDeviceAttribute"),
            arguments: { id: "dev_1", key: "custom:tier" },
          });
          expect(gated.ok, "the plan-gated call fails").toBe(false);
          expect(gated.text, "the caller sees the upstream's reason").toContain(PLAN_MESSAGE);
          expect(gated.text, "the caller sees the upstream status").toContain("HTTP 403");
          expect(gated.text, "the failure is a forbidden, not a rejected credential").toContain(
            "upstream_forbidden",
          );
          expect(gated.text, "no re-authenticate advice for a working connection").not.toMatch(
            /re-?authenticate|rejected credentials/i,
          );

          // A 401 is still a rejected credential, now with the upstream's reason.
          const revoked = yield* passthrough.call("invoke", {
            tool: toolId("getSession"),
            arguments: {},
          });
          expect(revoked.ok, "the revoked-token call fails").toBe(false);
          expect(revoked.text).toContain("connection_rejected");
          expect(revoked.text, "the 401 carries the upstream's reason").toContain("token revoked");
          expect(revoked.text, "a 401 still asks for re-authentication").toContain(
            "Re-authenticate",
          );
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({
              params: {
                owner: "org",
                integration: IntegrationSlug.make(slug),
                name: ConnectionName.make("main"),
              },
            })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
