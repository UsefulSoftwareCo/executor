import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator } from "@executor-js/emulate";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";
import { variable } from "@executor-js/sdk/http-auth";

import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([graphqlHttpPlugin()] as const);
const unique = (prefix: string): string => `${prefix}_${randomBytes(4).toString("hex")}`;

scenario(
  "GraphQL · failed introspection blocks connection creation with an actionable error",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);
    const slug = unique("graphql_health");
    const emulatorBaseUrl = yield* createEmulatorInstance("github", "graphql-health");
    const emulator = yield* Effect.promise(() =>
      connectEmulator({ baseUrl: emulatorBaseUrl, service: "github" }),
    );

    yield* Effect.promise(() =>
      emulator.faults.arm({
        match: { method: "POST", pathPattern: "/graphql" },
        response: { status: 401, body: { message: "Bad credentials" } },
        times: 10,
      }),
    );

    yield* client.graphql.addIntegration({
      payload: {
        endpoint: `${emulatorBaseUrl}/graphql`,
        slug,
        name: "GraphQL health",
        authenticationTemplate: [
          {
            slug: "header",
            type: "apiKey",
            headers: { Authorization: [variable("token")] },
          },
        ],
      },
    });

    yield* Effect.gen(function* () {
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the connection flow", async () => {
          await page.goto(`/integrations/${slug}?addAccount=1&owner=org&template=header`, {
            waitUntil: "networkidle",
          });
          await page.getByRole("heading", { name: /Add connection · GraphQL health/ }).waitFor();
        });

        await step("Submit a credential rejected during schema introspection", async () => {
          const dialog = page.getByRole("dialog", {
            name: /Add connection · GraphQL health/,
          });
          await dialog.getByRole("textbox", { name: "Authorization" }).fill("invalid-token");
          await dialog.getByRole("button", { name: "Continue" }).click();

          const alert = dialog.getByRole("alert");
          await alert.waitFor();
          const message = await alert.textContent();
          expect(message).toContain("The endpoint rejected the credential with HTTP 401.");
          expect(message).toContain("Check the credential and selected authentication method.");
          await dialog.getByText("Step 1 of 2").waitFor();
          expect(
            await page.getByText("No connections yet").count(),
            "the rejected credential is not saved",
          ).toBe(1);
        });
      });

      // The low-level API can still import an existing credential reference
      // without the browser's preflight. This models connections created before
      // the fix and proves their failed tool sync is no longer a silent zero.
      yield* client.connections.create({
        payload: {
          owner: "org",
          name: ConnectionName.make("legacy"),
          integration: IntegrationSlug.make(slug),
          template: AuthTemplateSlug.make("header"),
          value: "invalid-token",
        },
      });

      yield* browser.session(identity, async ({ page, step }) => {
        await step("A failed existing connection explains the empty tool catalogue", async () => {
          await page.goto(`/integrations/${slug}?tab=tools`, { waitUntil: "networkidle" });
          await page.getByText("Connection rejected", { exact: true }).first().waitFor();
          await page
            .getByText("The endpoint rejected the credential with HTTP 401.", {
              exact: false,
            })
            .waitFor();
          await page.getByRole("button", { name: "Check and sync tools" }).waitFor();
        });

        await step("The account row carries the same actionable health verdict", async () => {
          await page.getByRole("tab", { name: "Accounts" }).click();
          await page.getByText("Expired", { exact: true }).waitFor();
          await page
            .getByText("Check the credential and selected authentication method.", {
              exact: false,
            })
            .waitFor();
        });
      });
    }).pipe(
      Effect.ensuring(
        Effect.all(
          [
            client.integrations
              .remove({ params: { slug: IntegrationSlug.make(slug) } })
              .pipe(Effect.ignore),
            Effect.promise(() => emulator.faults.clear()).pipe(Effect.ignore),
          ],
          { concurrency: "unbounded" },
        ),
      ),
    );
  }),
);
