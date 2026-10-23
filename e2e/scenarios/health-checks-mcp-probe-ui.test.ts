// Opt-in MCP health probes. Without a configured probe an MCP connection's
// health is discovery only (dial + tools/list), and the editor offers only
// tools the server declares read-only on every connection.
//
// The upstream is a per-run instance of the published MCP emulator. Its tools
// carry no annotations, so none of them may serve as a probe: the editor stays
// hidden, nothing is saved, and no check ever calls a tool. The positive path
// (picking and probing a read-only tool) needs an upstream that advertises
// `readOnlyHint`, which the published emulator does not; plugin tests cover it.
import { randomBytes } from "node:crypto";

import { Effect } from "effect";
import { expect } from "@effect/vitest";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator } from "@executor-js/emulate";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { variable } from "@executor-js/sdk/http-auth";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([mcpHttpPlugin()] as const);
const template = AuthTemplateSlug.make("bearer");
const name = ConnectionName.make("main");

scenario(
  "Health checks (UI) · MCP offers no unannotated tool and checks discovery only",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const slug = IntegrationSlug.make(`hc-mcp-probe-${randomBytes(4).toString("hex")}`);
      const baseUrl = yield* createEmulatorInstance("mcp", "mcp-health-probe");
      const emulator = yield* Effect.promise(() => connectEmulator({ baseUrl }));
      const credential = yield* Effect.promise(() =>
        emulator.credentials.mint({ type: "bearer-token" }),
      );
      const token = credential.token;
      if (!token) return yield* Effect.die("Emulator did not mint a bearer token");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.mcp.addServer({
            payload: {
              transport: "remote",
              name: "Emulated MCP",
              endpoint: `${baseUrl}/mcp`,
              slug: String(slug),
              authenticationTemplate: [
                {
                  slug: "bearer",
                  type: "apiKey",
                  headers: { Authorization: ["Bearer ", variable("token")] },
                },
              ],
            },
          });
          yield* client.connections.create({
            payload: { owner: "org", name, integration: slug, template, value: token },
          });

          const candidates = yield* client.integrations.healthCheckCandidates({
            params: { slug },
          });
          expect(candidates, "an unannotated tool is never a probe candidate").toEqual([]);

          yield* browser.session(identity, async ({ page, step }) => {
            await step("The integration offers no MCP health check to set up", async () => {
              await visit(page, `/integrations/${slug}`);
              await page.getByText("main", { exact: true }).first().waitFor();
              expect(
                await page.getByRole("heading", { name: "Health check", exact: true }).count(),
              ).toBe(0);
              expect(await page.getByRole("button", { name: "Set up", exact: true }).count()).toBe(
                0,
              );
            });
          });

          expect(yield* client.integrations.healthCheckGet({ params: { slug } })).toBeNull();
          const discoveryOnly = yield* client.connections.checkHealth({
            params: { owner: "org", integration: slug, name },
            query: {},
          });
          expect(discoveryOnly.status, "no probe configured: discovery health").toBe("healthy");
          expect(discoveryOnly.detail).toContain("discovery only");

          const rejected = yield* client.connections.validate({
            payload: { owner: "org", integration: slug, template, value: "wrong-token" },
          });
          expect(rejected.status, "a rejected key is expired, not healthy").toBe("expired");
          expect(JSON.stringify(rejected)).not.toContain("Requires authentication");

          const requests = yield* Effect.promise(() => emulator.ledger.list());
          expect(
            requests.filter((request) =>
              JSON.stringify(request.request.body ?? null).includes('"tools/call"'),
            ),
            "no health check called a tool",
          ).toEqual([]);
          expect(
            requests.some((request) =>
              JSON.stringify(request.request.body ?? null).includes('"tools/list"'),
            ),
            "discovery reached the emulator",
          ).toBe(true);
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({ params: { owner: "org", integration: slug, name } })
            .pipe(Effect.ignore);
          yield* client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
