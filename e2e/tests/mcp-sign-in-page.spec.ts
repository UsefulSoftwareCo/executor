/**
 * The hosted sign-in pages, as the person approving a client sees them: the organization, access
 * and approval rows, the choices they offer, and the credential that results. The grant record
 * rule itself is covered by the grant choice scenarios; these drive the pages that set it.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Ref, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import {
  chooseConsent,
  chooseConsentOrganization,
  consentMenu,
  consentOption,
  consentRow,
  consentValue,
} from "../support/consent-page.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { deployMcpApp } from "../support/mcp-app.ts";
import { McpOAuth, type Grant } from "../support/mcp-oauth.ts";
import { ConnectionView, Execution } from "../support/mcp-connections.ts";
import { Target } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";
import { holdQuery, refreshVisiblePage } from "../support/query-transition.ts";
import { rawRequest, targetHosts } from "../support/role-hosts.ts";

const Organizations = Schema.Array(
  Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String }),
);
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
  approvalUrl: Schema.optional(Schema.String),
});
const Whoami = Schema.Struct({
  organization: Schema.Struct({ id: Schema.String }),
  access: Schema.Unknown,
  mode: Schema.String,
});
const Grants = Schema.Array(
  Schema.Struct({ clientId: Schema.String, grant: Schema.Struct({ id: Schema.String }) }),
);
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 900 };
const listFailure = "Could not load.";

/** An account-free app with a read tool, a write tool and a tool that always asks for approval. */
const deployApp = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const receipt = randomUUID();
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Sign-in page ${receipt.slice(0, 8)}`,
    files: [
      {
        path: "index.ts",
        content: `
import { defineApp, mutation, object, query, router, string } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, async () => ({
  tools: router({
    read: query({ description: "Read the receipt", input: object({}) }, async () => ({ read: ${JSON.stringify(receipt)} })),
    write: mutation({ description: "Write a message", input: object({ message: string() }) }, async (_, input) => ({ wrote: input.message })),
    review: mutation({ description: "Review after approval", input: object({}), approval: always() }, async () => ({ reviewed: true })),
  }),
}));
`,
      },
      appsManifest,
    ],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed);
  yield* Effect.addFinalizer(() =>
    api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
  );
  return { app, receipt, path: `tools[${JSON.stringify(app.slug)}]` };
});

/** A connection of the owner's in an organization, revoked when the scenario ends. */
const createConnection = (
  session: Session,
  organization: string,
  name: string,
  apps: readonly unknown[],
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const prefix = `/api/organizations/${organization}/mcp-connections`;
    const created = yield* api.request(session, "POST", prefix, { id: randomUUID(), name, apps });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const connection = yield* body(ConnectionView, created);
    yield* Effect.addFinalizer(() =>
      api.request(session, "POST", `${prefix}/${connection.id}/revoke`).pipe(Effect.orDie),
    );
    return connection;
  });

/** Every tool of one deployed app, run without an account. */
const allTools = (app: { readonly id: string }) => ({
  app: app.id,
  runsAs: [{ kind: "app" }],
  tools: { kind: "all" },
});

/** The scenario organization's name, as the page shows it. */
const organizationName = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const listed = yield* body(
    Organizations,
    yield* api.request(actors.owner, "GET", "/api/auth/organization/list"),
  );
  const found = listed.find((item) => item.id === actors.organization.id);
  if (found === undefined) return yield* Effect.die("The scenario organization is not listed");
  return found.name;
});

/** What `/mcp/whoami` says a bearer's grant holds. */
const whoami = (token: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const response = yield* rawRequest(`${targetHosts(target).mcp}/mcp/whoami`, {
      headers: { authorization: `Bearer ${Redacted.value(token)}` },
    });
    expect(response.status, response.text).toBe(200);
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Whoami))(response.text);
  });
const accessToken = (grant: Grant) => Redacted.make(Redacted.value(grant.tokens).access_token);

/** Keep a screenshot of the page as evidence. */
const shot = (name: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser,
      evidence = yield* Evidence;
    // Menus fade in and out; capture once those transitions end. Spinners repeat forever.
    const image = yield* browser.use(`Capture ${name}`, (page) =>
      page
        .evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
              .map((animation) => animation.finished),
          ),
        )
        .then(() => page.screenshot()),
    );
    yield* evidence.attach(`${name}.png`, "image/png", image);
  });

/** Capture the page at phone width, then return to the desktop window. */
const phoneShot = (name: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use("Use a phone-sized window", (page) => page.setViewportSize(phone));
    yield* shot(name);
    yield* browser.use("Return to a desktop window", (page) => page.setViewportSize(desktop));
  });

/** The page's frame, heading and decision stay on screen, with Connect available. */
const frameMounted = (page: Page) =>
  Promise.all([
    page.getByRole("heading", { name: "Connect to Executor", exact: true }).isVisible(),
    page.getByRole("button", { name: "Cancel", exact: true }).isVisible(),
    page.getByRole("button", { name: "Connect", exact: true }).isEnabled(),
  ]);

layer(HostedLive, { excludeTestServices: true })("MCP sign-in page", (it) => {
  it.effect(scenarios.signInPageDefault.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser,
          oauth = yield* McpOAuth;
        const organization = yield* organizationName;
        yield* browser.login(actors.owner);
        const review = Effect.gen(function* () {
          yield* browser.use("Use a desktop window", (page) => page.setViewportSize(desktop));
          yield* browser.use("Approve for the scenario organization", (page) =>
            chooseConsentOrganization(page, organization),
          );
          const shown = yield* browser.use("The rows show what the plain URL preselects", (page) =>
            Promise.all([
              consentValue(page, "Organization"),
              consentValue(page, "Access"),
              consentValue(page, "Approvals"),
              page
                .getByText(/^Access is sent to http:\/\/127\.0\.0\.1:\d+\. Only continue if you/u)
                .count(),
            ]),
          );
          expect(shown).toEqual([organization, "All apps", "Through your agent", 1]);
          yield* shot("default-desktop");
          yield* browser.use("Open the Access menu", (page) => consentMenu(page, "Access").click());
          const access = yield* browser.use("The Access menu starts with every app", (page) =>
            page.getByRole("option").allInnerTexts(),
          );
          expect(access[0]).toBe("All apps\nEvery app you can use, including apps you add later.");
          expect(access.at(-1)).toBe("New connection");
          yield* shot("access-open-desktop");
          yield* browser.use("Close the Access menu", (page) => page.keyboard.press("Escape"));
          yield* browser.use("Open the Approvals menu", (page) =>
            consentMenu(page, "Approvals").click(),
          );
          expect(
            yield* browser.use("Approvals are offered in order", (page) =>
              page.getByRole("option").allInnerTexts(),
            ),
          ).toEqual([
            "Through your agent\nYour agent shows you the request and resumes the call.",
            "In Executor\nYou review the call in your browser.",
            "In your client\nYour client prompts you, if it supports MCP prompts.",
          ]);
          yield* shot("approvals-open-desktop");
          yield* browser.use("Close the Approvals menu", (page) => page.keyboard.press("Escape"));
          yield* browser.use("Use a phone-sized window", (page) => page.setViewportSize(phone));
          const connect = yield* browser.use("Connect is on the first screen of a phone", (page) =>
            page.getByRole("button", { name: "Connect", exact: true }).boundingBox(),
          );
          expect(connect).not.toBeNull();
          expect((connect?.y ?? phone.height) + (connect?.height ?? 0)).toBeLessThanOrEqual(
            phone.height,
          );
          yield* shot("default-mobile");
          yield* browser.use("Open the Access menu on the phone", (page) =>
            consentMenu(page, "Access").click(),
          );
          yield* shot("access-open-mobile");
          yield* browser.use("Close the Access menu on the phone", (page) =>
            page.keyboard.press("Escape"),
          );
          yield* browser.use("Open the Approvals menu on the phone", (page) =>
            consentMenu(page, "Approvals").click(),
          );
          yield* shot("approvals-open-mobile");
          yield* browser.use("Close the Approvals menu on the phone", (page) =>
            page.keyboard.press("Escape"),
          );
          yield* browser.use("Return to a desktop window", (page) => page.setViewportSize(desktop));
        });
        const grant = yield* oauth.authorizeReviewing(review);
        expect(yield* whoami(accessToken(grant))).toMatchObject({
          access: { kind: "all" },
          mode: "model",
        });
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );

  it.effect(scenarios.signInPageConnection.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser,
          mcp = yield* McpClient,
          oauth = yield* McpOAuth;
        const [{ app, receipt, path }, hidden, organization] = yield* Effect.all(
          [deployApp, deployMcpApp, organizationName],
          { concurrency: 3 },
        );
        const name = `Reads ${randomUUID().slice(0, 6)}`;
        const connection = yield* createConnection(actors.owner, actors.organization.id, name, [
          { app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } },
        ]);
        yield* browser.login(actors.owner);
        const review = Effect.gen(function* () {
          yield* browser.use("Use a desktop window", (page) => page.setViewportSize(desktop));
          yield* browser.use("Approve for the scenario organization", (page) =>
            chooseConsentOrganization(page, organization),
          );
          yield* browser.use("Open the Access menu", (page) => consentMenu(page, "Access").click());
          // The menu names the connection and the app it reaches, not their IDs.
          expect(
            yield* browser.use("The connection lists its app by name", (page) =>
              consentOption(page, name).innerText(),
            ),
          ).toBe(`${name}\n${app.name}`);
          yield* shot("access-open-connection-desktop");
          yield* browser.use("Choose the connection", (page) =>
            consentOption(page, name)
              .click()
              .then(() => page.getByRole("listbox").waitFor({ state: "hidden" })),
          );
          expect(
            yield* browser.use("Access shows the chosen connection", (page) =>
              consentValue(page, "Access"),
            ),
          ).toBe(name);
          yield* shot("connection-chosen-desktop");
          yield* phoneShot("connection-chosen-mobile");
        });
        const grant = yield* oauth.authorizeReviewing(review);
        const token = accessToken(grant);
        expect(yield* whoami(token)).toMatchObject({
          access: { kind: "connection", id: connection.id, name },
          mode: "model",
        });
        const client = yield* mcp.connect(token, "chosen-connection");
        const run = (operation: string, code: string) =>
          client
            .use(operation, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.map((result) => result.structuredContent),
              Effect.flatMap(Schema.decodeUnknownEffect(Execution)),
            );
        const hiddenPath = `tools[${JSON.stringify(hidden.app.slug)}]`;
        const [read, write, excluded] = yield* Effect.all(
          [
            run("Call the connection's read tool", `return await ${path}.read({})`),
            run(
              "Call a tool the connection excludes",
              `return await ${path}.write({message: "x"})`,
            ),
            run(
              "Call an app the connection excludes",
              `return await ${hiddenPath}.echo({message: "x"})`,
            ),
          ],
          { concurrency: 3 },
        );
        expect(read.execution).toEqual({ ok: true, value: { read: receipt } });
        expect(write.execution.ok).toBe(false);
        expect(excluded.execution.ok).toBe(false);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );

  it.effect(scenarios.signInPageBrowserApprovals.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          mcp = yield* McpClient,
          oauth = yield* McpOAuth;
        const [{ path }, organization] = yield* Effect.all([deployApp, organizationName], {
          concurrency: 2,
        });
        yield* browser.login(actors.owner);
        const review = Effect.gen(function* () {
          yield* browser.use("Approve for the scenario organization", (page) =>
            chooseConsentOrganization(page, organization),
          );
          yield* browser.use("Choose approvals in Executor", (page) =>
            chooseConsent(page, "Approvals", "In Executor"),
          );
          expect(
            yield* browser.use("Approvals show the choice", (page) =>
              consentValue(page, "Approvals"),
            ),
          ).toBe("In Executor");
        });
        const grant = yield* oauth.authorizeReviewing(review);
        const token = accessToken(grant);
        expect(yield* whoami(token)).toMatchObject({ access: { kind: "all" }, mode: "browser" });
        const client = yield* mcp.connect(token, "browser-approvals");
        const pending = yield* client
          .use("Call a tool that needs approval", (client, signal) =>
            client.callTool(
              { name: "execute", arguments: { code: `return await ${path}.review({})` } },
              undefined,
              { signal },
            ),
          )
          .pipe(
            Effect.map((result) => result.structuredContent),
            Effect.flatMap(Schema.decodeUnknownEffect(Pending)),
          );
        // Browser approval links the review page; through the agent there is no link.
        expect(pending.approvalUrl).toBeDefined();
        const url = new URL(pending.approvalUrl ?? "");
        const reviewed = yield* api.request(
          actors.owner,
          "GET",
          `/api/mcp/approvals/${encodeURIComponent(pending.requestId)}${url.search}`,
        );
        expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );

  it.effect(scenarios.signInPageConnectionUrl.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser,
          oauth = yield* McpOAuth;
        const [{ app }, organization] = yield* Effect.all([deployApp, organizationName], {
          concurrency: 2,
        });
        const suffix = randomUUID().slice(0, 6);
        const named = yield* createConnection(
          actors.owner,
          actors.organization.id,
          `Named ${suffix}`,
          [allTools(app)],
        );
        const other = yield* createConnection(
          actors.owner,
          actors.organization.id,
          `Other ${suffix}`,
          [allTools(app)],
        );
        yield* browser.login(actors.owner);
        const review = Effect.gen(function* () {
          const shown = yield* browser.use("The URL's connection is preselected", (page) =>
            Promise.all([consentValue(page, "Organization"), consentValue(page, "Access")]),
          );
          expect(shown).toEqual([organization, named.name]);
          yield* browser.use("Choose the other connection", (page) =>
            chooseConsent(page, "Access", other.name),
          );
          expect(
            yield* browser.use("Access shows the person's choice", (page) =>
              consentValue(page, "Access"),
            ),
          ).toBe(other.name);
        });
        const grant = yield* oauth.authorizeReviewing(review, named.id);
        expect(yield* whoami(accessToken(grant))).toMatchObject({
          organization: { id: actors.organization.id },
          access: { kind: "connection", id: other.id, name: other.name },
        });
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );

  it.effect(scenarios.signInPageNewConnection.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser,
          oauth = yield* McpOAuth;
        const [{ app }, organization] = yield* Effect.all([deployApp, organizationName], {
          concurrency: 2,
        });
        const name = `Created meanwhile ${randomUUID().slice(0, 6)}`;
        const created = yield* Ref.make("");
        const editorPath = `/org/${actors.organization.slug}/connect/new`;
        yield* browser.login(actors.owner);
        const review = Effect.gen(function* () {
          yield* browser.use("Approve for the scenario organization", (page) =>
            chooseConsentOrganization(page, organization),
          );
          const consentUrl = yield* browser.use("Note the consent address", (page) =>
            Promise.resolve(page.url()),
          );
          yield* browser.use("Open the Access menu", (page) => consentMenu(page, "Access").click());
          const editor = yield* browser.use(
            "New connection opens the editor in a new tab",
            (page) =>
              Promise.all([
                page.context().waitForEvent("page"),
                consentOption(page, "New connection").click(),
              ]).then(([opened]) => opened.waitForURL(`**${editorPath}`).then(() => opened)),
          );
          expect(new URL(editor.url()).pathname).toBe(editorPath);
          const left = yield* browser.use("The sign-in page stays as it was", (page) =>
            Promise.all([Promise.resolve(page.url()), consentValue(page, "Access")]),
          );
          expect(left).toEqual([consentUrl, "All apps"]);
          // The person saves a connection in the editor's tab, then comes back.
          const connection = yield* createConnection(actors.owner, actors.organization.id, name, [
            allTools(app),
          ]);
          yield* Ref.set(created, connection.id);
          yield* browser.use("Close the editor's tab", () => editor.close());
          yield* browser.use("Return to the sign-in tab", (page) => page.bringToFront());
          yield* refreshVisiblePage;
          yield* browser.use("The new connection becomes the access", (page) =>
            consentRow(page, "Access").getByText(name, { exact: true }).waitFor(),
          );
          yield* shot("new-connection-chosen-desktop");
        });
        const grant = yield* oauth.authorizeReviewing(review);
        expect(yield* whoami(accessToken(grant))).toMatchObject({
          access: { kind: "connection", id: yield* Ref.get(created), name },
        });
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );

  it.effect(scenarios.signInPageDevice.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target;
        const hosts = targetHosts(target);
        const [{ app }, organization] = yield* Effect.all([deployApp, organizationName], {
          concurrency: 2,
        });
        const name = `Device ${randomUUID().slice(0, 6)}`;
        const connection = yield* createConnection(actors.owner, actors.organization.id, name, [
          allTools(app),
        ]);
        const json = (url: string, payload: unknown) =>
          rawRequest(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
        const form = (url: string, fields: Record<string, string>) =>
          rawRequest(url, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(fields).toString(),
          });
        const registered = yield* json(`${hosts.browser}/api/auth/oauth2/register`, {
          client_name: "Device sign-in client",
          token_endpoint_auth_method: "none",
          grant_types: [deviceGrant, "refresh_token"],
          response_types: [],
          scope: "mcp offline_access",
        });
        expect(registered.status, registered.text).toBe(201);
        const { client_id } = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ client_id: Schema.String })),
        )(registered.text);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const grants = yield* body(
              Grants,
              yield* api.request(actors.owner, "GET", "/api/auth/mcp/grants"),
            );
            for (const grant of grants.filter((item) => item.clientId === client_id))
              yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/revoke", {
                id: grant.grant.id,
              });
          }).pipe(Effect.orDie),
        );
        const started = yield* form(`${hosts.browser}/api/auth/oauth2/device-authorization`, {
          client_id,
          scope: "mcp offline_access",
          resource: `${hosts.mcp}/mcp`,
        });
        expect(started.status, started.text).toBe(200);
        const device = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              device_code: Schema.String,
              user_code: Schema.String,
              verification_uri_complete: Schema.String,
            }),
          ),
        )(started.text);
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        yield* browser.use("Use a desktop window", (page) => page.setViewportSize(desktop));
        yield* browser.use("Open the device page the client named", (page) =>
          page.goto(device.verification_uri_complete),
        );
        yield* browser.use("The page names the client", (page) =>
          page.getByText("Device sign-in client", { exact: true }).waitFor(),
        );
        yield* browser.use("Connect the device to the scenario organization", (page) =>
          chooseConsentOrganization(page, organization),
        );
        const shown = yield* browser.use("The device page has the same rows", (page) =>
          Promise.all([
            consentValue(page, "Code"),
            consentValue(page, "Access"),
            consentValue(page, "Approvals"),
          ]),
        );
        expect(shown).toEqual([device.user_code, "All apps", "Through your agent"]);
        yield* browser.use("Choose the connection", (page) => chooseConsent(page, "Access", name));
        yield* browser.use("Choose approvals in Executor", (page) =>
          chooseConsent(page, "Approvals", "In Executor"),
        );
        yield* shot("device-desktop");
        yield* phoneShot("device-mobile");
        yield* browser.use("Connect the device", (page) =>
          page.getByRole("button", { name: "Connect", exact: true }).click(),
        );
        yield* browser.use("The page confirms the device is connected", (page) =>
          page.getByText("Your device is connected.", { exact: true }).waitFor(),
        );
        const polled = yield* form(`${hosts.browser}/api/auth/oauth2/token`, {
          grant_type: deviceGrant,
          device_code: device.device_code,
          client_id,
        });
        expect(polled.status).toBe(200);
        const { access_token } = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({ access_token: Schema.RedactedFromValue(Schema.String) }),
          ),
        )(polled.text);
        expect(yield* whoami(access_token)).toMatchObject({
          organization: { id: actors.organization.id },
          access: { kind: "connection", id: connection.id, name },
          mode: "browser",
        });
      }),
    ),
  );

  it.effect(scenarios.signInPageConnectionsLoading.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser,
          oauth = yield* McpOAuth;
        const [{ app }, organization] = yield* Effect.all([deployApp, organizationName], {
          concurrency: 2,
        });
        const named = yield* createConnection(
          actors.owner,
          actors.organization.id,
          `Preselected ${randomUUID().slice(0, 6)}`,
          [allTools(app)],
        );
        const paths = [`/api/organizations/${actors.organization.id}/mcp-connections`];
        yield* browser.login(actors.owner);
        /** The browser reads the list after the page arrives; check the page while it is held. */
        const heldInPlace = (held: { readonly requested: Effect.Effect<string, unknown> }) =>
          Effect.gen(function* () {
            expect(paths).toContain(yield* held.requested);
            yield* browser.use("While held, the Access row is loading", (page) =>
              page.getByRole("status", { name: "Loading access", exact: true }).waitFor(),
            );
            expect(
              yield* browser.use("While held, the frame and buttons stay", frameMounted),
            ).toEqual([true, true, true]);
            // The loading row keeps the height of a loaded row.
            const heights = yield* browser.use("While held, the row keeps its height", (page) =>
              Promise.all(
                (["Access", "Approvals"] as const).map((row) =>
                  consentRow(page, row)
                    .locator("xpath=..")
                    .boundingBox()
                    .then((box) => box?.height),
                ),
              ),
            );
            expect(heights[0]).toBeDefined();
            expect(heights[0]).toBe(heights[1]);
          });
        const failureShown = browser.use("The failure takes the Access row", (page) =>
          consentRow(page, "Access").getByText(listFailure, { exact: true }).waitFor(),
        );

        // The list fails, then a retry loads it; a choice made meanwhile survives both.
        const failing = yield* holdQuery(paths, "fail");
        const retried = Effect.gen(function* () {
          yield* browser.use("Use a desktop window", (page) => page.setViewportSize(desktop));
          yield* heldInPlace(failing);
          yield* browser.use("Choose approvals in Executor while the list loads", (page) =>
            chooseConsent(page, "Approvals", "In Executor"),
          );
          yield* shot("connections-loading-desktop");
          yield* phoneShot("connections-loading-mobile");
          yield* failing.release;
          yield* failureShown;
          expect(
            yield* browser.use("Failed: the frame stays and Connect is available", frameMounted),
          ).toEqual([true, true, true]);
          expect(
            yield* browser.use("Failed: the approval choice is kept", (page) =>
              consentRow(page, "Approvals").innerText(),
            ),
          ).toBe("In Executor");
          yield* shot("connections-failed-desktop");
          yield* phoneShot("connections-failed-mobile");
          // A refresh can read the list more than once; hold every read until the check.
          const retry = yield* holdQuery(paths, "continue", { allRequests: true });
          yield* browser.use("Retry the list", (page) =>
            consentRow(page, "Access").getByRole("button", { name: "Retry", exact: true }).click(),
          );
          expect(paths).toContain(yield* retry.requested);
          // The failure stays in place while its retry runs, with Retry busy.
          expect(
            yield* browser.use("Retrying: the failure stays with Retry busy", (page) =>
              Promise.all([
                consentRow(page, "Access").getByText(listFailure, { exact: true }).isVisible(),
                consentRow(page, "Access").getByRole("button").isDisabled(),
                consentRow(page, "Access")
                  .getByRole("status", { name: "Loading", exact: true })
                  .isVisible(),
              ]),
            ),
          ).toEqual([true, true, true]);
          expect(
            yield* browser.use("Retrying: the approval choice is kept", (page) =>
              consentRow(page, "Approvals").innerText(),
            ),
          ).toBe("In Executor");
          yield* retry.release;
          yield* browser.use("Retried: the Access menu returns", (page) =>
            consentMenu(page, "Access").waitFor(),
          );
          expect(
            yield* browser.use("Retried: the list loads and the choices are kept", (page) =>
              Promise.all([
                consentValue(page, "Organization"),
                consentValue(page, "Access"),
                consentValue(page, "Approvals"),
              ]),
            ),
          ).toEqual([organization, "All apps", "In Executor"]);
        });
        const first = yield* oauth.authorizeReviewing(retried);
        expect(yield* whoami(accessToken(first))).toMatchObject({
          access: { kind: "all" },
          mode: "browser",
        });

        // A list that cannot load does not stop the person approving the URL's connection.
        const failingAgain = yield* holdQuery(paths, "fail");
        const failed = Effect.gen(function* () {
          yield* heldInPlace(failingAgain);
          yield* failingAgain.release;
          yield* failureShown;
        });
        const fallback = yield* oauth.authorizeReviewing(failed, named.id);
        expect(yield* whoami(accessToken(fallback))).toMatchObject({
          organization: { id: actors.organization.id },
          access: { kind: "connection", id: named.id, name: named.name },
          mode: "model",
        });
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );
});
