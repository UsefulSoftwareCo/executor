import { randomBytes } from "node:crypto";
import { expect } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { wsdlHttpPlugin } from "@executor-js/plugin-wsdl/api";
import { ordersWsdl } from "@executor-js/plugin-wsdl/testing";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";
import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([wsdlHttpPlugin()] as const);
scenario(
  "WSDL · import a contract and discover SOAP operations",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);
    const slug = IntegrationSlug.make(`orders-${randomBytes(4).toString("hex")}`);
    yield* Effect.ensuring(
      Effect.gen(function* () {
        const rejected = yield* Effect.exit(
          client.wsdl.addIntegration({
            payload: {
              slug,
              name: "Orders",
              wsdl: ordersWsdl.replace('style="document"', 'style="rpc"'),
            },
          }),
        );
        expect(Exit.isFailure(rejected), "RPC contracts must fail import").toBe(true);
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the WSDL import form", async () => {
            await page.goto("/integrations/add/wsdl", { waitUntil: "networkidle" });
            await page.getByLabel("WSDL contract").waitFor();
          });
          await step("Import the Orders WSDL contract", async () => {
            await page.getByLabel("Integration name").fill("Orders SOAP");
            await page.getByLabel("Namespace", { exact: true }).fill(slug);
            await page.getByLabel("WSDL contract").fill(ordersWsdl);
            await page.getByRole("button", { name: "Add WSDL integration" }).click();
            await page.waitForURL(`**/integrations/${slug}`, { timeout: 30_000 });
            await page.getByText("Orders SOAP", { exact: true }).first().waitFor();
            await page.getByText("No connections yet", { exact: true }).waitFor();
            expect(await page.getByText("Orders SOAP", { exact: true }).count()).toBeGreaterThan(0);
          });
        });
        yield* client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: slug,
            template: AuthTemplateSlug.make("none"),
            values: {},
          },
        });
        const tools = yield* client.tools.list({ query: {} });
        expect(tools.filter((tool) => tool.integration === slug).map((tool) => tool.name)).toEqual([
          "GetOrder",
        ]);
      }),
      Effect.gen(function* () {
        yield* client.connections
          .remove({
            params: { owner: "org", integration: slug, name: ConnectionName.make("main") },
          })
          .pipe(Effect.ignore);
        yield* client.integrations.remove({ params: { slug } }).pipe(Effect.ignore);
      }),
    );
  }),
);
