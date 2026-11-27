import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomBytes } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import {
  analyticsEvents,
  type AnalyticsEvent,
  type AnalyticsScope,
} from "../support/collector-events.ts";
import { Emulators } from "../support/emulators.ts";
import { reveal } from "../support/failure-text.ts";
import { McpClient } from "../support/mcp-client.ts";
import { authorizeBrowserMcp } from "../support/mcp-oauth.ts";
import { Target, driver } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";

const common = new Set([
  "product_version",
  "environment",
  "release",
  "executor_test",
  "executor_internal",
  "$set",
  "$process_person_profile",
  "event_id",
]);
const own = (event: AnalyticsEvent | undefined) =>
  Object.fromEntries(Object.entries(event?.properties ?? {}).filter(([key]) => !common.has(key)));
const named = (events: readonly AnalyticsEvent[], name: string) =>
  events.filter((event) => event.event === name);
const eventsWhen = (scope: AnalyticsScope, ready: (events: readonly AnalyticsEvent[]) => boolean) =>
  analyticsEvents(scope).pipe(
    Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: ready }),
    Effect.timeout("15 seconds"),
  );
const Session = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });

layer(HostedLive, { excludeTestServices: true })("MCP connection funnel", (it) => {
  it.effect(scenarios.mcpFunnelFirstUse.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          mcp = yield* McpClient,
          target = yield* Target,
          http = yield* HttpClient.HttpClient;
        expect(target.metadata.mode).toBe("managed");
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Funnel first use",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const organization = { organization: actors.organization.id };

        const user = (yield* body(
          Session,
          yield* api.request(actors.owner, "GET", "/api/auth/get-session"),
        )).user.id;

        const refused = yield* http.execute(
          yield* HttpClientRequest.bodyJson(
            HttpClientRequest.post(`${target.metadata.origin}/mcp`).pipe(
              HttpClientRequest.bearerToken(Redacted.value(key.key)),
              HttpClientRequest.setHeaders({
                accept: "application/json, text/event-stream",
                "x-executor-organization": actors.organization.id,
              }),
            ),
            { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
          ),
        );
        const refusal = yield* refused.text;
        expect(refusal).toContain('"error"');

        const first = yield* mcp.connect(key.key, "funnel-first", organization);
        yield* first.use("The client lists its tools", (client, signal) =>
          client.listTools(undefined, { signal }),
        );
        const once = yield* eventsWhen(
          organization,
          (events) =>
            named(events, "mcp_client_initialized").length > 0 &&
            named(events, "mcp_tools_listed").length > 0,
        );
        const initialized = named(once, "mcp_client_initialized");
        expect(initialized).toHaveLength(1);
        expect(initialized[0]?.distinct_id).toBe(user);
        expect(own(initialized[0])).toEqual({
          method: "initialize",
          client_family: "other",
          client_version: "1",
          protocol_version: expect.stringMatching(
            /^(2026-07-28|2025-11-25|2025-06-18|2025-03-26)$/u,
          ),
          client_id: `pat:${key.id}`,
          source: "mcp",
          organization_id: actors.organization.id,
        });
        expect(JSON.stringify(initialized)).not.toContain("executor-e2e");
        const listed = named(once, "mcp_tools_listed");
        expect(listed).toHaveLength(1);
        expect(listed[0]?.distinct_id).toBe(user);
        expect(own(listed[0])).toEqual({
          client_id: initialized[0]?.properties.client_id,
          source: "mcp",
          organization_id: actors.organization.id,
        });

        yield* first.use("The client lists its tools again", (client, signal) =>
          client.listTools(undefined, { signal }),
        );
        const second = yield* mcp.connect(key.key, "funnel-second", organization);
        yield* second.use("A second session lists its tools", (client, signal) =>
          client.listTools(undefined, { signal }),
        );
        expect(
          (yield* api.request(
            actors.owner,
            "POST",
            `/api/organizations/${actors.organization.id}/feedback`,
            { message: "Synthetic feedback after the funnel's MCP requests" },
          )).status,
        ).toBe(200);
        const events = yield* eventsWhen(organization, (events) =>
          events.some(
            (event) =>
              event.event === "product_operation_completed" && event.properties.area === "feedback",
          ),
        );
        expect(named(events, "mcp_client_initialized")).toEqual(initialized);
        expect(named(events, "mcp_tools_listed")).toEqual(listed);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpFunnelAgentOrganization.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          target = yield* Target;
        expect(target.metadata.mode).toBe("managed");
        const user = (yield* body(
          Session,
          yield* api.request(actors.owner, "GET", "/api/auth/get-session"),
        )).user.id;
        const browser = yield* Browser;
        yield* browser.login(actors.owner);
        yield* browser.omitNetworkTrace;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const tab = yield* Effect.acquireRelease(
              browser.use("Open the client's sign-in tab", (page) => page.context().newPage()),
              (tab) =>
                driver("Close the client's sign-in tab", () => tab.close()).pipe(Effect.orDie),
            );
            return yield* authorizeBrowserMcp(tab, targetHosts(target).browser, {
              resource: `${targetHosts(target).mcp}/mcp`,
              client: "Funnel consent client",
            });
          }),
        );
        const connected = named(
          yield* eventsWhen(
            { person: user },
            (events) => named(events, "agent_connected").length > 0,
          ),
          "agent_connected",
        );
        expect(connected.map((event) => event.properties.organization_id)).toEqual([
          actors.organization.id,
        ]);
      }),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("MCP connection funnel sign-up", (it) => {
  it.effect(scenarios.mcpFunnelSignupOrigin.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          emulators = yield* Emulators,
          target = yield* Target;
        expect(target.metadata.mode).toBe("managed");
        const app = targetHosts(target).browser;
        const email = `funnel-${randomBytes(8).toString("hex")}@example.test`;
        yield* browser.omitNetworkTrace;
        yield* browser.use("Open sign-in from an MCP client's authorization", (page) =>
          page.goto(
            `/login?redirect=${encodeURIComponent("/mcp/authorize?client_id=funnel-fixture")}`,
          ),
        );
        yield* browser.use("Enter the synthetic email", (page) =>
          page.getByLabel("Email", { exact: true }).fill(email),
        );
        const origin = yield* browser.use("Read the sign-in origin cookie", (page) =>
          page
            .context()
            .cookies(app)
            .then((cookies) =>
              cookies.filter((cookie) => cookie.name === "executor_sign_in_origin"),
            ),
        );
        expect(origin.map((cookie) => [cookie.value, cookie.path, cookie.sameSite])).toEqual([
          ["mcp_authorize", "/", "Lax"],
        ]);
        const received = yield* emulators.received(email);
        yield* browser.use("Request a sign-in code", (page) =>
          page.getByRole("button", { name: "Continue", exact: true }).click(),
        );
        const delivered = yield* emulators.mail(email, received);
        yield* browser.use("Enter the delivered code", (page) =>
          page.getByLabel("Sign-in code", { exact: true }).fill(reveal(delivered.code)),
        );
        yield* browser.use("Verify the code", (page) =>
          page.getByRole("button", { name: "Sign in", exact: true }).click(),
        );
        yield* browser.use("Sign-in leaves the sign-in form", (page) =>
          page.waitForFunction(
            () =>
              window.location.pathname !== "/login" ||
              document.querySelector("h1")?.textContent === "Create a passkey",
          ),
        );
        const user = yield* browser
          .use("Read the new account's session", (page) =>
            page.evaluate(() => fetch("/api/auth/get-session").then((response) => response.json())),
          )
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session)));
        const signups = named(
          yield* eventsWhen(
            { person: user.user.id },
            (events) => named(events, "cloud_signup_completed").length > 0,
          ),
          "cloud_signup_completed",
        );
        expect(signups.map(own)).toEqual([{ signup_origin: "mcp_authorize" }]);
        expect(
          yield* browser.use("The sign-in origin is cleared", (page) =>
            page
              .context()
              .cookies(app)
              .then((cookies) =>
                cookies.filter((cookie) => cookie.name === "executor_sign_in_origin"),
              ),
          ),
        ).toEqual([]);
        expect(JSON.stringify(signups)).not.toContain("funnel-fixture");
      }).pipe(Effect.provide(Emulators.layer)),
    ),
  );
});
