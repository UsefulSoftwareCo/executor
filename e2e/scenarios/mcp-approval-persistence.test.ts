import { randomBytes } from "node:crypto";
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeElicitationMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";
import { parseBrowserApproval } from "../src/surfaces/mcp";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([mcpHttpPlugin()] as const);

scenario(
  "MCP · browser approval preserves the chosen lifetime and defaults to once",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const mcp = yield* Mcp;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const slug = IntegrationSlug.make(`approval_terms_${randomBytes(4).toString("hex")}`);
      const server = yield* serveMcpServer(makeElicitationMcpServer);
      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Approval terms",
          endpoint: server.url,
          slug,
          remoteTransport: "streamable-http",
        },
      });
      yield* Effect.gen(function* () {
        yield* client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: slug,
            template: AuthTemplateSlug.make("none"),
            value: "",
          },
        });
        const session = mcp.session(identity, { elicitationMode: "browser" });
        yield* session.listTools();
        for (const scope of ["session", "always", ""] as const) {
          const paused = yield* session.call("execute", {
            code: `return await tools.${slug}.org.main.remembered_echo({value:"browser"});`,
          });
          const approval = parseBrowserApproval(paused);
          const [resumed] = yield* Effect.all(
            [
              session.awaitResume(approval.executionId),
              browser.session(identity, async ({ page, step }) => {
                await step(`Approve ${scope || "once"} through the console`, async () => {
                  await visit(page, approval.approvalUrl);
                  const choice = page.getByLabel("Remember this approval");
                  await choice.waitFor();
                  expect(await choice.inputValue(), "every approval starts as one-time").toBe("");
                  if (scope !== "") await choice.selectOption(scope);
                  await page.getByRole("button", { name: "Approve", exact: true }).click();
                  await page.getByText("Approve sent").waitFor();
                });
              }),
            ],
            { concurrency: "unbounded" },
          );
          expect(resumed.ok).toBe(true);
          expect(resumed.text, "the chosen lifetime reaches the upstream MCP server").toContain(
            `approved:browser:${scope || "once"}`,
          );
        }
      }).pipe(Effect.ensuring(client.mcp.removeServer({ params: { slug } }).pipe(Effect.orDie)));
    }),
  ),
);
