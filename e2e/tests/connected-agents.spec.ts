/**
 * Members see the agents they authorized over OAuth and can revoke one at once. Only agents that
 * still hold a usable token are listed, by last use. Grants that can never be used again are
 * revoked when the same client authorizes again, and by the daily expiry after 30 idle days.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schedule, Schema } from "effect";
import type { Page } from "playwright";
import { scenarios } from "../test-plan.ts";
import { Actors, password } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { serverControl } from "../support/server-control.ts";

const Agent = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  connectedAt: Schema.String,
  lastActiveAt: Schema.NullOr(Schema.String),
  access: Schema.Struct({ kind: Schema.String }),
});
const Grants = Schema.Array(Schema.Struct({ grant: Schema.Struct({ id: Schema.String }) }));
const day = 24 * 60 * 60_000;

class GrantStillListed extends Schema.TaggedError<GrantStillListed>()("GrantStillListed", {}) {}

layer(HostedLive, { excludeTestServices: true })("Connected agents", (it) => {
  it.effect(scenarios.connectedAgents.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        const path = `/api/organizations/${actors.organization.id}/mcp-agents`;
        const agents = (session: typeof actors.owner) =>
          api
            .request(session, "GET", path)
            .pipe(Effect.flatMap((response) => body(Schema.Array(Agent), response)));
        yield* browser.login(actors.owner);
        const grant = yield* evidence.step("Authorize an MCP client", oauth.authorize);
        const access = Redacted.make(Redacted.value(grant.tokens).access_token);
        const client = yield* mcp.connect(access, "connected-agent");
        yield* client.use("The agent lists tools", (session) => session.listTools());

        const listed = yield* agents(actors.owner);
        const agent = listed.find((item) => item.id === grant.grantId);
        expect(agent).toMatchObject({ name: "Executor E2E client", access: { kind: "all" } });
        expect(agent?.lastActiveAt).not.toBeNull();
        // Each member sees only the agents they authorized.
        expect((yield* agents(actors.member)).some((item) => item.id === grant.grantId)).toBe(
          false,
        );

        yield* browser.use("Open Connections", (page) =>
          page.goto(`/org/${actors.organization.slug}/connect`),
        );
        const row = (page: Page) =>
          page
            .getByRole("region", { name: "Connected agents" })
            .getByRole("listitem")
            .filter({ hasText: "Executor E2E client" });
        yield* browser.use("The agent is listed with its access", (page) =>
          row(page).filter({ hasText: "Every app" }).waitFor(),
        );
        yield* browser.checkpoint("Connected agents on Connections");
        yield* browser.use("Revoke the agent", (page) =>
          row(page)
            .getByRole("button", { name: "Revoke Executor E2E client", exact: true })
            .click(),
        );
        yield* browser.checkpoint("Confirm revoking the agent");
        yield* browser.use("Confirm", (page) =>
          page.getByRole("button", { name: "Revoke agent", exact: true }).click(),
        );
        // The dialog closes only after the server confirms the revocation.
        yield* browser.use("The confirmation closes", (page) =>
          page.getByRole("dialog").waitFor({ state: "detached" }),
        );
        yield* browser.use("The agent leaves the list", (page) =>
          row(page).waitFor({ state: "detached" }),
        );

        expect((yield* agents(actors.owner)).some((item) => item.id === grant.grantId)).toBe(false);
        yield* evidence.step(
          "The revoked agent can no longer call MCP or refresh",
          Effect.gen(function* () {
            const denied = yield* api.request(yield* api.session(), "GET", "/mcp", undefined, {
              authorization: `Bearer ${Redacted.value(access)}`,
            });
            expect(denied.status).toBe(401);
            expect(yield* oauth.refreshStatus(grant)).toBe(400);
          }),
        );
        const again = yield* api.request(actors.owner, "POST", `${path}/${grant.grantId}/revoke`);
        expect(again.status).toBe(404);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
  it.effect(scenarios.connectedAgentsActivity.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          oauth = yield* McpOAuth;
        const path = `/api/organizations/${actors.organization.id}/mcp-agents`;
        const agents = api
          .request(actors.owner, "GET", path)
          .pipe(Effect.flatMap((response) => body(Schema.Array(Agent), response)));
        yield* browser.login(actors.owner);
        // Connected in this order, so connection time alone would list the newest first.
        const older = yield* evidence.step(
          "Authorize an agent that will refresh",
          oauth.authorizeNamed("Older agent"),
        );
        const newer = yield* evidence.step(
          "Authorize an agent that will only hold its refresh token",
          oauth.authorizeNamed("Newer agent"),
        );
        const expiring = yield* evidence.step(
          "Authorize an agent that asks for no refresh token",
          oauth.authorizeWithoutRefresh("Expiring agent"),
        );
        const fresh = yield* agents;
        for (const grant of [older, newer, expiring])
          expect(fresh.some((item) => item.id === grant.grantId)).toBe(true);

        // Access tokens last an hour. Past it, only an agent with a refresh token can continue.
        yield* serverControl("stop");
        yield* serverControl("clock/advance", 200, { milliseconds: 61 * 60_000 });
        yield* serverControl("start");
        yield* evidence.step(
          "The agent without a refresh token is refused",
          Effect.gen(function* () {
            const denied = yield* api.request(yield* api.session(), "GET", "/mcp", undefined, {
              authorization: `Bearer ${Redacted.value(expiring.tokens).access_token}`,
            });
            expect(denied.status).toBe(401);
          }),
        );
        yield* evidence.step("The older agent refreshes", oauth.refresh(older));

        const listed = yield* agents;
        const ours = listed.filter((item) =>
          [older, newer, expiring].some((grant) => grant.grantId === item.id),
        );
        // The refreshed agent was used last; the newer one is listed through its refresh token.
        // The agent without a usable token is no longer listed.
        expect(ours.map((item) => item.name)).toEqual(["Older agent", "Newer agent"]);
        expect(ours.every((item) => item.lastActiveAt !== null)).toBe(true);
        const [olderUse, newerUse] = ours.map((item) => Date.parse(item.lastActiveAt ?? ""));
        expect(olderUse).toBeGreaterThan(newerUse ?? Number.POSITIVE_INFINITY);

        yield* browser.use("Open Connections", (page) =>
          page.goto(`/org/${actors.organization.slug}/connect`),
        );
        const section = (page: Page) => page.getByRole("region", { name: "Connected agents" });
        const rows = (page: Page) => section(page).getByRole("listitem");
        yield* browser.use("Listed agents show when they were last used", (page) =>
          rows(page).filter({ hasText: "Older agent" }).filter({ hasText: "Last used" }).waitFor(),
        );
        const order = yield* browser.use("Read the agents in order", (page) =>
          rows(page).locator("p.font-medium").allInnerTexts(),
        );
        expect(order).toEqual(["Older agent", "Newer agent"]);
        expect(
          yield* browser.use("The expired agent is not listed", (page) =>
            section(page).getByText("Expiring agent", { exact: true }).count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("There is no inactive section", (page) =>
            section(page)
              .getByRole("button", { name: /^Inactive/ })
              .count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Only usable agents, by last use");
        yield* browser.use("Revoke Newer agent", (page) =>
          rows(page)
            .filter({ hasText: "Newer agent" })
            .getByRole("button", { name: "Revoke Newer agent", exact: true })
            .click(),
        );
        yield* browser.use("Confirm", (page) =>
          page.getByRole("button", { name: "Revoke agent", exact: true }).click(),
        );
        yield* browser.use("The confirmation closes", (page) =>
          page.getByRole("dialog").waitFor({ state: "detached" }),
        );
        yield* browser.use("Newer agent leaves the list", (page) =>
          section(page).getByText("Newer agent", { exact: true }).waitFor({ state: "detached" }),
        );

        const remaining = (yield* agents).filter((item) =>
          [older, newer, expiring].some((grant) => grant.grantId === item.id),
        );
        expect(remaining.map((item) => item.name)).toEqual(["Older agent"]);
        yield* evidence.step(
          "The revoked active agent can no longer refresh",
          Effect.gen(function* () {
            expect(yield* oauth.refreshStatus(newer)).toBe(400);
          }),
        );
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );
  it.effect(scenarios.connectedAgentsReauthorize.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          oauth = yield* McpOAuth;
        const unrevoked = api.request(actors.owner, "GET", "/api/auth/mcp/grants").pipe(
          Effect.flatMap((response) => body(Grants, response)),
          Effect.map((grants) => new Set(grants.map((item) => item.grant.id))),
        );
        yield* browser.login(actors.owner);
        // Each authorization registers again on a new loopback port, as a client that lost its
        // credentials does, so these are three registrations of one client and one other client.
        const dead = yield* evidence.step(
          "Authorize a client that asks for no refresh token",
          oauth.authorizeWithoutRefresh("Returning agent"),
        );
        const live = yield* evidence.step(
          "Authorize the same client with a refresh token",
          oauth.authorizeNamed("Returning agent"),
        );
        const other = yield* evidence.step(
          "Authorize another client that asks for no refresh token",
          oauth.authorizeWithoutRefresh("Other agent"),
        );
        // Past an hour, the grants without a refresh token hold no usable token.
        yield* serverControl("stop");
        yield* serverControl("clock/advance", 200, { milliseconds: 61 * 60_000 });
        yield* serverControl("start");
        const replacement = yield* evidence.step(
          "The client authorizes again",
          oauth.authorizeNamed("Returning agent"),
        );

        const remaining = yield* unrevoked;
        expect(remaining.has(dead.grantId)).toBe(false);
        expect(remaining.has(live.grantId)).toBe(true);
        expect(remaining.has(other.grantId)).toBe(true);
        expect(remaining.has(replacement.grantId)).toBe(true);
        yield* evidence.step("The live grant still refreshes", oauth.refresh(live));
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );
  it.effect(scenarios.connectedAgentsIdleExpiry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          oauth = yield* McpOAuth;
        const unrevoked = api.request(actors.owner, "GET", "/api/auth/mcp/grants").pipe(
          Effect.flatMap((response) => body(Grants, response)),
          Effect.map((grants) => new Set(grants.map((item) => item.grant.id))),
        );
        yield* browser.login(actors.owner);
        const idle = yield* evidence.step(
          "Authorize an agent that will go idle",
          oauth.authorizeNamed("Idle agent"),
        );
        const refreshing = yield* evidence.step(
          "Authorize an agent that will keep refreshing",
          oauth.authorizeNamed("Refreshing agent"),
        );
        // Refresh tokens last 30 days. On day 29 both are valid, and the daily expiry run at this
        // start keeps both.
        yield* serverControl("stop");
        yield* serverControl("clock/advance", 200, { milliseconds: 29 * day });
        yield* serverControl("start");
        const renewed = yield* evidence.step(
          "The refreshing agent refreshes on day 29",
          oauth.refresh(refreshing),
        );
        // On day 31 the idle agent's refresh token has expired and it has been idle for 31 days.
        yield* serverControl("stop");
        yield* serverControl("clock/advance", 200, { milliseconds: 2 * day });
        yield* serverControl("start");
        // The owner's browser session expired meanwhile.
        const signIn = yield* api.request(actors.owner, "POST", "/api/auth/sign-in/email", {
          email: "owner@example.test",
          password,
        });
        expect(signIn.status).toBe(200);
        // Self-host runs the daily expiry at each start, after serving begins.
        yield* evidence.step(
          "The idle grant is revoked",
          unrevoked.pipe(
            Effect.filterOrFail(
              (ids) => !ids.has(idle.grantId),
              () => new GrantStillListed(),
            ),
            Effect.retry({
              while: (error) => Schema.is(GrantStillListed)(error),
              // Once a second stays under the auth endpoints' rate limit.
              schedule: Schedule.spaced("1 second"),
              times: 30,
            }),
          ),
        );
        expect((yield* unrevoked).has(refreshing.grantId)).toBe(true);
        yield* evidence.step("The refreshing agent still refreshes", oauth.refresh(renewed));
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );
});
