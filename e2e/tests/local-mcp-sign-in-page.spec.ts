/**
 * Local sign-in shows what the MCP URL names as plain rows, in the hosted pages' layout, and offers
 * no menus: approving keeps what the URL names.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { createHash, randomBytes } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { consentValue } from "../support/consent-page.ts";
import { Evidence } from "../support/evidence.ts";
import { pairLocalOperator } from "../support/mcp-consent.ts";
import { revokeClientGrants } from "../support/mcp-connections.ts";
import { oauthCallback } from "../support/mcp-oauth.ts";
import { Target } from "../support/platform.ts";

layer(TestLive, { excludeTestServices: true })("Local MCP sign-in page", (it) => {
  it.effect(scenarios.localSignInPage.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          evidence = yield* Evidence,
          target = yield* Target;
        const origin = target.metadata.origin;
        const operator = yield* pairLocalOperator;
        const state = randomBytes(24).toString("hex");
        const receiver = yield* oauthCallback(state);
        const registered = yield* api.request(
          yield* api.session(),
          "POST",
          "/api/auth/oauth2/register",
          {
            client_name: "Local sign-in client",
            redirect_uris: [receiver.url],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          },
        );
        expect(registered.status).toBe(201);
        const { client_id } = yield* body(Schema.Struct({ client_id: Schema.String }), registered);
        yield* revokeClientGrants(operator, () => [client_id]);
        const authorization = new URL(`${origin}/api/auth/oauth2/authorize`);
        authorization.search = new URLSearchParams({
          response_type: "code",
          client_id,
          redirect_uri: receiver.url,
          code_challenge: createHash("sha256")
            .update(randomBytes(32).toString("base64url"))
            .digest("base64url"),
          code_challenge_method: "S256",
          scope: "mcp offline_access",
          resource: `${origin}/mcp?elicitation_mode=browser`,
          state,
        }).toString();
        yield* browser.omitNetworkTrace;
        yield* browser.login(operator);
        yield* browser.use("Use a desktop window", (page) =>
          page.setViewportSize({ width: 1280, height: 900 }),
        );
        yield* browser.use("Open the client's sign-in", (page) => page.goto(authorization.href));
        yield* browser.use("The page names the client", (page) =>
          page.getByText("Local sign-in client", { exact: true }).waitFor(),
        );
        const shown = yield* browser.use("The rows show what the URL names", (page) =>
          Promise.all([
            consentValue(page, "Access"),
            consentValue(page, "Approvals"),
            page.getByRole("combobox").count(),
            page.getByRole("term").allInnerTexts(),
            page
              .getByText(/^Access is sent to http:\/\/127\.0\.0\.1:\d+\. Only continue if you/u)
              .count(),
          ]),
        );
        expect(shown).toEqual(["All apps", "In Executor", 0, ["Access", "Approvals"], 1]);
        const desktop = yield* browser.use("Capture the local page", (page) => page.screenshot());
        yield* evidence.attach("local-desktop.png", "image/png", desktop);
        const phone = yield* browser.use("Capture the local page on a phone", (page) =>
          page.setViewportSize({ width: 390, height: 844 }).then(() => page.screenshot()),
        );
        yield* evidence.attach("local-mobile.png", "image/png", phone);
        const buttons = yield* browser.use("Cancel and Connect share the row equally", (page) =>
          Promise.all(
            ["Cancel", "Connect"].map((name) =>
              page
                .getByRole("button", { name, exact: true })
                .boundingBox()
                .then((box) => box?.width),
            ),
          ),
        );
        expect(buttons[0]).toBeDefined();
        expect(buttons[0]).toBe(buttons[1]);
        yield* browser.use("Connect", (page) =>
          page.getByRole("button", { name: "Connect", exact: true }).click(),
        );
        yield* receiver.code;
      }),
    ),
  );
});
